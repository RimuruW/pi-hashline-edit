Read a text file and return line-level hash anchors.

Each returned text line is prefixed as `LINE#HASH:content`. Copy those anchors verbatim when calling `edit`.

Use `offset` and `limit` to page through large files. Default limit: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}.

Empty files return an insertion advisory. Supported images (JPEG, PNG, GIF, WebP) are returned as attachments. Binary files and directories are rejected.

If the first selected line exceeds the byte budget, the tool returns an advisory instead of a partial line, because partial lines cannot produce valid anchors.