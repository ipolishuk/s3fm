# Working with files and folders

- The toolbar **+** button opens an actions menu (items depend on permissions):
  - **Add bucket** — `add_bucket` (hidden if the permission is missing);
  - **Create folder** — `create_folder`;
  - **Upload files** — `upload_files`, or drag-and-drop onto the file list;
  - **Upload folder** — `upload_folder`, or drag-and-drop a folder from the desktop.
- **Context menu (right-click)** on a file or folder row opens the same actions as below. Items that are not allowed for your role are disabled or hidden; in selection mode enabled items apply to all selected objects. Preview and Properties are available only when exactly one file is selected.
  - **File:** Download (`download_file`), Copy (`copy_file` + `upload_files` on a destination), Move (`move_file` + `delete_file` + upload on a destination), Delete (`delete_file`), Preview (`preview`, only for supported types), Properties (opens the file properties dialog), Edit ACL (`edit_file_acl`, same dialog as bulk ACL for one file).
  - **Folder:** Download as ZIP (`download_folder`), Copy (`copy_folder` + upload on a destination), Move (`move_folder` + `delete_folder` + upload on a destination), Delete (`delete_folder`), Edit ACL (`edit_file_acl`, applied recursively to all files inside). Preview and Properties are not shown for folders.
- **Preview** — from the context menu or the button in file properties; opens a new browser tab (`/files/view/...`). Supported: JPEG, PNG, GIF, WebP, BMP, PDF, JSON, TXT, MD, HTML, CSS. Requires permission `preview` (separate from `download_file`) and bucket access. HTML is sandboxed (no scripts); Markdown is shown as plain text.
- **Download** — from the context menu. A file downloads directly (`download_file`); a folder is packed into a ZIP archive (`download_folder`).
- Click a **file row** to open file properties; click a **folder row** to open the folder.
- **Copy** and **Move** — from the context menu for one object, or bulk selection; pick destination bucket and path in the dialog.
- **Delete** — from the context menu or bulk selection; confirmation is required.
- Upload, delete, copy, move, and bulk ACL show progress bars. Active jobs survive page refresh and reconnect automatically.
