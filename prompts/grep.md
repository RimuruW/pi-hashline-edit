Search files using ripgrep. Every matched line returns as `LINE#HASH:content` — copy those anchors verbatim into `edit` without a prior `read`.

The `pattern` is a regular expression unless `literal: true`. Results respect `.gitignore` by default (ripgrep's default). Use `path` to scope to a file or directory; use `glob` to filter by filename pattern (e.g. `"**/*.ts"`).

Set `context` (0–5) to include surrounding lines around each match. Overlapping context ranges within one file are merged. Set `limit` to cap matched lines (default 50, max 200); truncated output ends with a notice.

No matches → "No matches found for <pattern>."
