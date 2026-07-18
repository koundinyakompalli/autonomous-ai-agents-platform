# Harvey Teams Package

This directory contains the Microsoft Teams app package assets for Harvey, Specter's conversational front door.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Teams app manifest template |
| `color.png` | 192x192 app icon |
| `outline.png` | 32x32 outline icon |

## Harvey service expectations

The packaged app targets the Harvey service, which exposes:

- `POST /api/messages`
- `GET /health`

Harvey must be reachable over HTTPS from Microsoft Bot Framework.

## Required runtime secrets

- `TEAMS_APP_ID`
- `TEAMS_APP_PASSWORD`
- `TEAMS_TENANT_ID`

## Commands users can type to Harvey

Current built-in command surface:

- `/new`
- `/sessions`
- `/status`
- `/help`
- `/history`
- `/cancel`
- `/share`

There is also a hidden `/admin` command path.

## Packaging

Create a zip containing exactly:

- `manifest.json`
- `color.png`
- `outline.png`

Example:

```bash
cd teams
zip -r harvey-teams.zip manifest.json color.png outline.png
```

Replace the app ID placeholder before packaging:

```bash
sed -i.bak "s/{{TEAMS_APP_ID}}/$TEAMS_APP_ID/g" manifest.json
zip -r harvey-teams.zip manifest.json color.png outline.png
mv manifest.json.bak manifest.json
```

## Deployment note

The current Terraform stack exposes Harvey behind an ALB. Use the Terraform output `harvey_bot_endpoint` as the Bot Framework messaging endpoint.
