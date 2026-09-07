# Administrator settings

**Settings** (gear icon in the user menu):

- **admin** — all tabs (Buckets, Clouds, Users, Roles, Search, Status).
- **storage_admin** or any role with `add_bucket` — **Buckets tab only** (buckets they created).

- **Buckets** — connect S3 buckets: endpoint, credentials, display name, TLS and CA options. You can also add a bucket from the file manager toolbar **+** menu (`add_bucket`). Creating a bucket sets `created_by`, auto-grants access with the creator’s default role, and assigns a **server-generated Bucket ID** (cannot be changed later). Creators can view/edit their own bucket settings; **delete** is admin-only. Non-admin users cannot retarget cloud/key outside allowlisted endpoints.
- **Clouds** — group buckets by cloud provider; endpoint URLs and **Enable public URL** (shows or hides **Source URL** in file properties). Admin only.
- **Users** — accounts, passwords, global and per-bucket roles. Admin only.
  - When **adding** or **copying** a user, you can look up a person in AD/LDAP (search icon next to the username): at least 6 characters; partial match on login / display name / email. One match fills the fields immediately; several matches show a selectable list. On copy, permissions and bucket/cloud lists are kept; username / full name / email are set anew.
  - LDAP is enabled with `LDAP_URI`, `LDAP_BASE_DN`, `LDAP_BIND_USER`, and `LDAP_BIND_PASSWORD` (see README). Prefer `ldaps://` and a read-only service account.
- **Roles** — built-in and custom roles with a permission checklist. Admin only.
- **Search** — Meilisearch connection, per-bucket indexing switch, reindex one or all buckets. Index enable/disable and reindex controls are in the table header and row columns (no right-click menu on Search). Admin only.
- **Status** — live checks for Database, S3, LDAP, SSO/OIDC, and Meilisearch (configured vs reachable). If LDAP search is disabled in the user form, open this tab: usually missing `LDAP_URI` / bind credentials, or bind failure. Admin only.
- **Context menu (right-click)** on Users, Roles, Clouds, and Buckets rows: Copy, Edit, Delete (same shared context-menu styling as the file list). Edit/Delete may be disabled for protected built-in rows (for example the `admin` role or the `admin` user). On Buckets, Delete is disabled for non-admin.
