# Permissions and roles

Access is defined by your **default role**, optional **per-bucket role** overrides, and the list of buckets (or clouds) your account is allowed to use. If an action is missing or returns *access denied*, ask an administrator to adjust roles or bucket assignment.

## How roles are applied

- Each user has a **default role** (`admin`, `storage_admin`, `storage_editor`, `storage_viewer`, or a custom role).
- In **Settings → Users**, an administrator can assign a **different role per bucket**; that role applies only inside that bucket.
- The **admin** role always keeps full access to every allowed bucket and can open **all Settings tabs**.
- The **storage_admin** role has the same object powers and `add_bucket` as admin; it opens **Settings → Buckets only** (buckets they created: view/edit settings). Deleting buckets remains **admin-only**.
- Seeing a bucket in the list still requires it to be granted to your account (allowed buckets / clouds) or created by you (auto-grant).

## Built-in roles

- **admin** — full Settings access and full object operations in allowed buckets (including `preview` and `add_bucket`).
- **storage_admin** — full storage operations like admin; **Settings → Buckets** for own buckets (`created_by`); Bucket ID is server-generated and locked.
- **storage_editor** — upload, download, preview, delete, copy, move, create folders, edit ACL (within assigned buckets).
- **storage_viewer** — browse, preview, and download files only.

## Custom roles

In **Settings → Roles** administrators can create roles with any combination of permissions from the list below. Built-in roles can also be edited (except **admin**, which only the `admin` user may change).

Assign a custom role as the user’s default role or as a per-bucket override in **Settings → Users**.

## Permission checklist (Settings → Roles)

### Add

| Permission | Description |
|------------|-------------|
| add_bucket | Register a new bucket (toolbar **+** and Settings → Buckets). Opens Settings → Buckets for non-admin. Creator is auto-granted access; Bucket ID is server-generated. |

### Copy

| Permission | Description |
|------------|-------------|
| copy_file | Copy a single file |
| copy_files_multi | Copy multiple selected files |
| copy_folder | Copy a single folder (recursive) |
| copy_folder_multi | Copy multiple selected folders |

Copy also needs `upload_files` on at least one destination bucket (for folders — also `upload_folder` or `create_folder`). A multi permission (`*_multi`) is enough for a single object as well.

### Create

| Permission | Description |
|------------|-------------|
| create_folder | Create an empty folder |

### Delete

| Permission | Description |
|------------|-------------|
| delete_file | Delete a single file |
| delete_files_multi | Delete multiple selected files |
| delete_folder | Delete a single folder (recursive) |
| delete_folder_multi | Delete multiple selected folders |

### Download

| Permission | Description |
|------------|-------------|
| download_file | Download a single file |
| download_files_multi | Download multiple selected files (selection mode) |
| download_folder | Download a folder as a ZIP archive |

### Preview

| Permission | Description |
|------------|-------------|
| preview | Open images, PDF, JSON, TXT, MD, HTML and CSS in a new browser tab (`/files/view/...`). Independent of `download_file`. A shared view URL still requires login, this permission, and bucket access. |

### Edit

| Permission | Description |
|------------|-------------|
| edit_file_acl | View and edit S3 object ACL (file properties, context menu for one file, and bulk ACL in selection mode; folders apply ACL recursively to all files inside) |

### Move

| Permission | Description |
|------------|-------------|
| move_file | Move a single file (also needs delete_file and upload_files on a destination) |
| move_files_multi | Move multiple files (also needs delete_files_multi and upload_files on a destination) |
| move_folder | Move a single folder (also needs delete_folder and upload on a destination) |
| move_folder_multi | Move multiple folders (also needs delete_folder_multi and upload on a destination) |

### Upload

| Permission | Description |
|------------|-------------|
| upload_files | Upload files |
| upload_folder | Upload a folder from the desktop (directory structure preserved) |

## Selection mode and permissions

- To use **Select** on files you generally need at least one “multiple” permission (download, delete, copy, move) or `edit_file_acl`.
- To select **folders** for copy/move/delete you need the corresponding folder or multi-folder permission; for **bulk ACL** — `edit_file_acl` is enough.
- **Download** of a single file needs `download_file` or `download_files_multi` (multi implies single); multiple files need `download_files_multi`. Folders are not included in bulk download.
- The **file/folder context menu** uses the same single-object permissions (`download_file` / `download_folder`, `copy_file` / `copy_folder` plus `upload_files` on a destination, `move_file`+`delete_file` / `move_folder`+`delete_folder` plus upload on a destination, `delete_file` / `delete_folder`, `preview`, `edit_file_acl`). Unavailable actions are disabled.
