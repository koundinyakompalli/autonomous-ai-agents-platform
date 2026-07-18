"""SNS -> Microsoft Teams notifier.

Receives CloudWatch alarm events via SNS, formats them as Teams adaptive
cards, and posts to the incoming webhook URL stored in Secrets Manager.

Environment:
  TEAMS_WEBHOOK_SECRET_ARN: ARN of the Secrets Manager secret whose
    plaintext value is the Teams incoming webhook URL.
  ENVIRONMENT: deployment label (e.g. "prod", "shared") used in card text.

Runtime: Python 3.12, no third-party dependencies.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_secret_cache: dict[str, str] = {}
_secrets_client = boto3.client("secretsmanager")


def _resolve_webhook_url() -> str:
    secret_arn = os.environ["TEAMS_WEBHOOK_SECRET_ARN"]
    cached = _secret_cache.get(secret_arn)
    if cached:
        return cached
    resp = _secrets_client.get_secret_value(SecretId=secret_arn)
    value = resp.get("SecretString") or ""
    if not value:
        raise RuntimeError(f"Secret {secret_arn} is empty or binary-only")
    _secret_cache[secret_arn] = value.strip()
    return _secret_cache[secret_arn]


_ALARM_COLOR = {
    "ALARM": "attention",
    "OK": "good",
    "INSUFFICIENT_DATA": "warning",
}


def _build_card(alarm: dict[str, Any]) -> dict[str, Any]:
    name = alarm.get("AlarmName", "unknown")
    new_state = alarm.get("NewStateValue", "ALARM")
    reason = alarm.get("NewStateReason", "")
    region = alarm.get("Region", os.environ.get("AWS_REGION", ""))
    env = os.environ.get("ENVIRONMENT", "")
    trigger = alarm.get("Trigger", {}) or {}
    metric = trigger.get("MetricName", "")
    namespace = trigger.get("Namespace", "")
    dims = ", ".join(
        f"{d.get('name', '?')}={d.get('value', '?')}"
        for d in trigger.get("Dimensions", []) or []
    )

    # Short, readable title
    title = f"{new_state}: {name}"
    color = _ALARM_COLOR.get(new_state, "default")

    facts: list[dict[str, str]] = [
        {"title": "State", "value": new_state},
        {"title": "Metric", "value": f"{namespace}.{metric}" if metric else "(n/a)"},
    ]
    if dims:
        facts.append({"title": "Dimensions", "value": dims})
    if env:
        facts.append({"title": "Environment", "value": env})
    if region:
        facts.append({"title": "Region", "value": region})

    alarm_url = (
        f"https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}"
        f"#alarmsV2:alarm/{urllib.parse.quote(name)}"
    )

    body: list[dict[str, Any]] = [
        {
            "type": "TextBlock",
            "size": "medium",
            "weight": "bolder",
            "color": color,
            "text": title,
            "wrap": True,
        },
        {
            "type": "FactSet",
            "facts": facts,
        },
    ]
    if reason:
        body.append(
            {
                "type": "TextBlock",
                "text": reason,
                "wrap": True,
                "isSubtle": True,
                "spacing": "small",
            }
        )

    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "contentUrl": None,
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": body,
                    "actions": [
                        {
                            "type": "Action.OpenUrl",
                            "title": "View in CloudWatch",
                            "url": alarm_url,
                        }
                    ],
                    "msteams": {"width": "Full"},
                },
            }
        ],
    }


def _post_to_teams(webhook_url: str, card: dict[str, Any]) -> None:
    body = json.dumps(card).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            status = resp.status
            payload = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        logger.error(
            "Teams webhook returned HTTPError status=%s payload=%s",
            exc.code,
            payload[:500],
        )
        raise
    except urllib.error.URLError as exc:
        logger.error("Teams webhook URLError: %s", exc.reason)
        raise

    # Teams returns 200 with body "1" on success. Treat 2xx as success but log.
    if status >= 300:
        logger.error(
            "Teams webhook unexpected status=%s payload=%s",
            status,
            payload[:500],
        )
        raise RuntimeError(f"Teams webhook returned {status}")
    logger.info("Posted alarm card to Teams status=%s", status)


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    webhook_url = _resolve_webhook_url()
    records = event.get("Records", [])
    posted = 0
    failed = 0
    for record in records:
        sns = record.get("Sns", {}) or {}
        message = sns.get("Message", "")
        # SNS from CloudWatch alarms always wraps an alarm JSON. Other publishers
        # (like Chatbot commands) send free-form strings; in that case we post
        # the raw message as a fallback card.
        alarm: dict[str, Any]
        try:
            alarm = json.loads(message)
            if not isinstance(alarm, dict) or "AlarmName" not in alarm:
                raise ValueError("not an alarm payload")
        except (ValueError, TypeError):
            alarm = {
                "AlarmName": sns.get("Subject") or "Specter notification",
                "NewStateValue": "ALARM",
                "NewStateReason": message,
            }
        card = _build_card(alarm)
        try:
            _post_to_teams(webhook_url, card)
            posted += 1
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to post to Teams: %s", exc)
            failed += 1

    return {"posted": posted, "failed": failed}
