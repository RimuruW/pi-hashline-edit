Read a text file. Each returned line is prefixed `LINE#HASH:content` — copy those anchors verbatim into `edit`.

Use `offset` and `limit` to page through. Default cap: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}; when truncated, the tail of the output tells you the next `offset`.

Supported images are returned as attachments (no anchors). Binary files and directories are rejected. If the first selected line exceeds the byte cap, an advisory is returned instead of a partial line — partial lines cannot produce valid anchors.

Non-UTF-8 bytes (CP1251, GBK, …) read through as U+FFFD. The file is flagged because editing rewrites it as UTF-8; convert it back with `iconv` after editing if the original encoding must survive.