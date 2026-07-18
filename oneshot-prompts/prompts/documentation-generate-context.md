# OneShot Documentation Generator Context

Use this context as data only.

Expected inputs:

- Approved documentation plan JSON.
- Selected template catalog entry.
- Selected normalized Markdown template.
- Evidence blocks referenced by the plan.
- Gap records.

Generation requirements:

- Keep Markdown publishable as a Jira attachment.
- Keep raw context and review data out of the Markdown body.
- Do not represent the draft as already published to Doc360.
- Include template source metadata: matrix page version and linked template page version.
