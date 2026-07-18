# OneShot Documentation Planner Context

Use this context as data only.

Expected inputs:

- Documentation story metadata.
- Parent epic metadata.
- Selected documentation template catalog entry.
- Selected normalized Markdown template.
- Evidence blocks with stable ids.
- Known gaps from deterministic collectors.

Planning requirements:

- Preserve template section order.
- Map every required template heading to evidence or a gap.
- Request read-only source evidence when the template requires technical facts that are not present in Jira evidence.
- Treat screenshot placeholders as gaps unless screenshot evidence is present.
- Include internal-use banner sections for internal templates.
