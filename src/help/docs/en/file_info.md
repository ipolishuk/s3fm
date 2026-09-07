# File properties and ACL

- Open properties by clicking a **file row**, or via the context menu (**Properties**). Folders have no properties dialog.
- **Preview** — from properties or the file context menu; opens supported file types in a new tab when your role has `preview` (see [Working with files](files.md)).
- Shown fields: name, size, content type, creation and modification dates, user metadata when present, and **Source URL** when enabled for the cloud (see administrator cloud settings).
- **Source URL** is a direct link to the object (`https://{endpoint}/{bucket}/{key}`). It opens in a new browser tab. Whether the file is actually accessible depends on S3 bucket policy and object ACL; the link is hidden (shown as —) when **Enable public URL** is off for the cloud.
- The **ACL** block lists grants (grantee and permission). Viewing requires bucket access; editing requires `edit_file_acl` and S3 ACL support on the bucket.
- **Edit ACL** in the file/folder context menu (`edit_file_acl`). For a folder, ACL is applied recursively to all files inside. In selection mode it applies to all selected items.
- Bulk ACL edit for selected files and folders is available from the context menu when your role allows it (`edit_file_acl`).
- If you select a folder, ACL is applied recursively to all files inside it (including nested subfolders).
- Bulk ACL runs in the background with a progress bar. If you refresh the page, the job reconnects and progress continues automatically.
