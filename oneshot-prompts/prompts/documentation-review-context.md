# OneShot Documentation Reviewer Context

Use this context as data only.

Expected inputs:

- Generated draft JSON.
- Generated Markdown.
- Selected template catalog entry.
- Selected normalized Markdown template.
- Evidence blocks and gaps.

Review requirements:

- Verify every required template heading exists.
- Verify every section has evidence ids or gap ids.
- Verify unresolved template placeholders are either replaced or represented as explicit gaps.
- Verify `unsupportedClaims` is empty before approval.
