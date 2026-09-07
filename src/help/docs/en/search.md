# Search

- The search field above the file list finds objects by name within the current bucket.
- With Meilisearch indexing enabled, search is fast across the whole bucket tree.
- Without Meilisearch the service scans S3 directly — slower on large buckets.
- Clear the field with × or leave it empty to return to normal folder browsing.
- Administrators manage indexing in **Settings → Search** (status, per-bucket toggle, reindex).
