Read a file and return its contents with line-level hash anchors.

Text files are returned with each line prefixed as `LINE#HASH:content`. Use these `LINE#HASH` references as anchors when calling `edit`.

Empty files return an advisory instead of a synthetic empty-line anchor. The preview also hides the internal terminal-newline sentinel, so use `append`/`prepend` without `pos` for empty-file or EOF insertions.

Images (JPEG, PNG, GIF, WebP) are returned as attachments. Binary files and directories are rejected.

Supported parameters:
- `path` — file path (relative or absolute).
- `offset` — start reading from this line number (1-indexed, optional).
- `limit` — maximum number of lines to return (optional).

Default limit: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}.

When the first selected line exceeds the byte budget, the tool returns an advisory instead of a partial line, because partial lines produce unusable hash anchors.
