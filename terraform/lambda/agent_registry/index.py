import base64
import json
import logging
import os
import re
from typing import Any

import boto3
import pymysql


LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

SECRETS = boto3.client("secretsmanager")


def _load_secret(secret_id: str) -> Any:
    response = SECRETS.get_secret_value(SecretId=secret_id)
    secret_string = response.get("SecretString")
    if secret_string is not None:
        try:
            return json.loads(secret_string)
        except json.JSONDecodeError:
            return secret_string

    secret_binary = response.get("SecretBinary")
    if secret_binary is None:
        raise ValueError(f"Secret {secret_id} returned neither SecretString nor SecretBinary")

    decoded = base64.b64decode(secret_binary).decode("utf-8")
    try:
        return json.loads(decoded)
    except json.JSONDecodeError:
        return decoded


def _get_jira_token() -> str:
    secret = _load_secret(os.environ["JIRA_TOKEN_SECRET_ARN"])
    if isinstance(secret, str):
        return secret

    if isinstance(secret, dict):
        for key in ("token", "jira_token", "value", "JIRA_TOKEN"):
            value = secret.get(key)
            if value:
                return str(value)

        if len(secret) == 1:
            return str(next(iter(secret.values())))

    raise ValueError("JIRA token secret does not contain a usable token value")


def _connect():
    credentials = _load_secret(os.environ["DB_SECRET_ARN"])
    if not isinstance(credentials, dict):
        raise ValueError("Database secret must be a JSON object with username and password")

    return pymysql.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "3306")),
        user=credentials["username"],
        password=credentials["password"],
        database=os.environ["DB_NAME"],
        autocommit=True,
        connect_timeout=5,
        cursorclass=pymysql.cursors.DictCursor,
    )


def _normalize_agent(agent: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": str(agent["name"]).strip(),
        "description": str(agent["description"]).strip(),
        "additional_context": (agent.get("additional_context") or "").strip() or None,
        "model": str(agent.get("model") or "us.anthropic.claude-sonnet-4-6").strip(),
        "task_type": str(agent["task_type"]).strip(),
        "jql": str(agent["jql"]).strip(),
        "is_active": bool(agent.get("is_active", False)),
    }


def _normalize_repository(repository: dict[str, Any]) -> dict[str, Any]:
    repo_name = str(repository["repo_name"]).strip()
    repo_url = str(repository["repo_url"]).strip()
    default_branch = str(repository.get("default_branch") or "main").strip()
    if not repo_url.startswith("https://github.com/"):
        raise ValueError("Repository URL must be a GitHub HTTPS clone URL")
    if not repo_url.endswith(".git"):
        raise ValueError("Repository URL must end with .git")
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", default_branch):
        raise ValueError("default_branch contains unsupported characters")

    return {
        "repo_name": repo_name,
        "repo_url": repo_url,
        "description": (repository.get("description") or "").strip() or None,
        "default_branch": default_branch,
    }


def _serialize_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None

    if "is_active" in row:
        row["is_active"] = bool(row["is_active"])

    for field in ("created_at", "updated_at"):
        if row.get(field) is not None:
            row[field] = row[field].isoformat()

    return row


def _get_agent(connection, name: str) -> dict[str, Any] | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, name, description, additional_context, model, task_type, jql,
                   jira_username, jira_token, is_active, created_at, updated_at
              FROM agents
             WHERE name = %s
             LIMIT 1
            """,
            (name,),
        )
        row = cursor.fetchone()

    return _serialize_row(row)


def _get_repository(connection, repo_name: str) -> dict[str, Any] | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, repo_name, repo_url, description, default_branch, created_at
              FROM code_repositories
             WHERE repo_name = %s
             LIMIT 1
            """,
            (repo_name,),
        )
        row = cursor.fetchone()

    return _serialize_row(row)


def _upsert_agent(connection, payload: dict[str, Any]) -> dict[str, Any]:
    agent = _normalize_agent(payload["agent"])
    jira_token = _get_jira_token()
    jira_username = os.environ["JIRA_USERNAME"]

    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO agents
              (name, description, additional_context, model, task_type, jql, jira_token, jira_username, is_active)
            VALUES
              (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              description        = VALUES(description),
              additional_context = VALUES(additional_context),
              model              = VALUES(model),
              task_type          = VALUES(task_type),
              jql                = VALUES(jql),
              jira_token         = VALUES(jira_token),
              jira_username      = VALUES(jira_username),
              is_active          = VALUES(is_active),
              updated_at         = CURRENT_TIMESTAMP
            """,
            (
                agent["name"],
                agent["description"],
                agent["additional_context"],
                agent["model"],
                agent["task_type"],
                agent["jql"],
                jira_token,
                jira_username,
                agent["is_active"],
            ),
        )

    return {
        "operation": "upsert_agent",
        "agent": _get_agent(connection, agent["name"]),
    }


def _set_agent_active(connection, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload["name"]).strip()
    is_active = bool(payload["is_active"])

    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE agents
               SET is_active = %s,
                   updated_at = CURRENT_TIMESTAMP
             WHERE name = %s
            """,
            (is_active, name),
        )

        if cursor.rowcount == 0:
            raise ValueError(f"Agent not found: {name}")

    return {
      "operation": "set_agent_active",
      "agent": _get_agent(connection, name),
    }


def _upsert_repository(connection, payload: dict[str, Any]) -> dict[str, Any]:
    repository = _normalize_repository(payload["repository"])

    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO code_repositories
              (repo_name, repo_url, description, default_branch)
            VALUES
              (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              repo_url     = VALUES(repo_url),
              description  = VALUES(description),
              default_branch = VALUES(default_branch)
            """,
            (
                repository["repo_name"],
                repository["repo_url"],
                repository["description"],
                repository["default_branch"],
            ),
        )

    return {
        "operation": "upsert_repository",
        "repository": _get_repository(connection, repository["repo_name"]),
    }


def handler(event, _context):
    LOGGER.info("agent-registry request: %s", json.dumps(event))
    operation = event.get("operation")
    if operation not in {"upsert_agent", "get_agent", "set_agent_active", "upsert_repository", "get_repository"}:
        raise ValueError(f"Unsupported operation: {operation}")

    connection = _connect()
    try:
        if operation == "upsert_agent":
            return _upsert_agent(connection, event)

        if operation == "get_agent":
            name = str(event["name"]).strip()
            return {
                "operation": "get_agent",
                "agent": _get_agent(connection, name),
            }

        if operation == "upsert_repository":
            return _upsert_repository(connection, event)

        if operation == "get_repository":
            repo_name = str(event["repo_name"]).strip()
            return {
                "operation": "get_repository",
                "repository": _get_repository(connection, repo_name),
            }

        return _set_agent_active(connection, event)
    finally:
        connection.close()
