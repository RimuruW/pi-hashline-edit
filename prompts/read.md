Read a UTF-8 text file. Each returned line is prefixed `LINE#HASH:content` — copy those anchors verbatim into `edit`.

Use `offset` and `limit` to page through. Default cap: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}; when truncated, the tail of the output tells you the next `offset`.

Supported images are returned as attachments (no anchors). Binary files and directories are rejected. If the first selected line exceeds the byte cap, an advisory is returned instead of a partial line — partial lines cannot produce valid anchors.