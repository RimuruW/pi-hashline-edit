Read a file. For text files, each line is prefixed with `LINE#HASH:` (for example `12#MQ:content`). Use these references as anchors for `edit`.

If the selected first line is too large to fit in a safe hashline preview, the tool returns an advisory instead of a partial tagged line.

Images (jpg, png, gif, webp) are sent as attachments.
Default limit: {{DEFAULT_MAX_LINES}} lines or {{DEFAULT_MAX_BYTES}}.
