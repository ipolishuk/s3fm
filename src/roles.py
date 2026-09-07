# Ролевая модель: права (permissions) и встроенные роли.

import json

from flask import g, session

# Роли пользователей
ROLE_ADMIN = 'admin'
ROLE_STORAGE_ADMIN = 'storage_admin'
ROLE_STORAGE_EDITOR = 'storage_editor'
ROLE_STORAGE_VIEWER = 'storage_viewer'

VALID_ROLES = (
    ROLE_ADMIN,
    ROLE_STORAGE_ADMIN,
    ROLE_STORAGE_EDITOR,
    ROLE_STORAGE_VIEWER,
)

# Старые имена → новые (SSO env, одноразовая миграция БД)
LEGACY_ROLE_ALIASES = {
    'editor': ROLE_STORAGE_EDITOR,
    'viewer': ROLE_STORAGE_VIEWER,
}

# Зарезервированные имена ролей (не создаются в settings, не назначаются пользователям)
RESERVED_ROLE_NAMES = frozenset({'custom'})


def is_reserved_role_name(name):
    return (name or '').strip().lower() in RESERVED_ROLE_NAMES


def normalize_role_name(role_name: str) -> str:
    """Привести имя роли (в т.ч. legacy editor/viewer) к актуальному."""
    key = (role_name or '').strip().lower()
    return LEGACY_ROLE_ALIASES.get(key, key)


def is_settings_admin_role(role_name: str = None) -> bool:
    """Только admin — полный доступ ко всем вкладкам и API настроек (users/roles/…)."""
    key = (role_name if role_name is not None else _role() or '').strip().lower()
    return key == ROLE_ADMIN


def is_full_storage_role(role_name: str = None) -> bool:
    """admin / storage_admin: полные права на объекты, без per-bucket downgrade."""
    key = (role_name if role_name is not None else _role() or '').strip().lower()
    return key in (ROLE_ADMIN, ROLE_STORAGE_ADMIN)

# Права (permissions) — можно добавлять новые и назначать любой роли
PERM_UPLOAD_FILES = 'upload_files'
PERM_UPLOAD_FOLDER = 'upload_folder'
PERM_CREATE_FOLDER = 'create_folder'
PERM_DELETE_FILE = 'delete_file'
PERM_DELETE_FOLDER = 'delete_folder'
PERM_DOWNLOAD_FILE = 'download_file'
PERM_DOWNLOAD_FOLDER = 'download_folder'
PERM_DOWNLOAD_FILES_MULTI = 'download_files_multi'
PERM_DELETE_FOLDER_MULTI = 'delete_folder_multi'
PERM_DELETE_FILES_MULTI = 'delete_files_multi'
PERM_COPY_FILE = 'copy_file'
PERM_COPY_FOLDER = 'copy_folder'
PERM_COPY_FILES_MULTI = 'copy_files_multi'
PERM_COPY_FOLDER_MULTI = 'copy_folder_multi'
PERM_MOVE_FILE = 'move_file'
PERM_MOVE_FOLDER = 'move_folder'
PERM_MOVE_FILES_MULTI = 'move_files_multi'
PERM_MOVE_FOLDER_MULTI = 'move_folder_multi'
PERM_EDIT_FILE_ACL = 'edit_file_acl'
PERM_ADD_BUCKET = 'add_bucket'
PERM_PREVIEW = 'preview'

_STORAGE_FULL_PERMISSIONS = [
    PERM_ADD_BUCKET,
    PERM_DELETE_FILE,
    PERM_DOWNLOAD_FILE,
    PERM_PREVIEW,
    PERM_UPLOAD_FILES,
    PERM_EDIT_FILE_ACL,
    PERM_DELETE_FILES_MULTI,
    PERM_DOWNLOAD_FILES_MULTI,
    PERM_CREATE_FOLDER,
    PERM_DELETE_FOLDER,
    PERM_DOWNLOAD_FOLDER,
    PERM_UPLOAD_FOLDER,
    PERM_DELETE_FOLDER_MULTI,
    PERM_COPY_FILE,
    PERM_COPY_FOLDER,
    PERM_COPY_FILES_MULTI,
    PERM_COPY_FOLDER_MULTI,
    PERM_MOVE_FILE,
    PERM_MOVE_FOLDER,
    PERM_MOVE_FILES_MULTI,
    PERM_MOVE_FOLDER_MULTI,
]

# Какие права назначены ролям (кастомные роли — в таблице roles)
ROLE_PERMISSIONS = {
    ROLE_ADMIN: list(_STORAGE_FULL_PERMISSIONS),
    ROLE_STORAGE_ADMIN: list(_STORAGE_FULL_PERMISSIONS),
    ROLE_STORAGE_EDITOR: [
        PERM_DELETE_FILE,
        PERM_DOWNLOAD_FILE,
        PERM_PREVIEW,
        PERM_UPLOAD_FILES,
        PERM_EDIT_FILE_ACL,
        PERM_CREATE_FOLDER,
        PERM_DELETE_FOLDER,
        PERM_DOWNLOAD_FOLDER,
        PERM_UPLOAD_FOLDER,
        PERM_COPY_FILE,
        PERM_MOVE_FILE,
    ],
    ROLE_STORAGE_VIEWER: [
        PERM_DOWNLOAD_FILE,
    ],
}

# Полный список прав для API настроек и валидации JSONB в БД (всегда по алфавиту id)
KNOWN_PERMISSION_IDS = tuple(sorted({
    PERM_ADD_BUCKET,
    PERM_COPY_FILE,
    PERM_COPY_FILES_MULTI,
    PERM_COPY_FOLDER,
    PERM_COPY_FOLDER_MULTI,
    PERM_MOVE_FILE,
    PERM_MOVE_FILES_MULTI,
    PERM_MOVE_FOLDER,
    PERM_MOVE_FOLDER_MULTI,
    PERM_CREATE_FOLDER,
    PERM_DELETE_FILE,
    PERM_DELETE_FILES_MULTI,
    PERM_DELETE_FOLDER,
    PERM_DELETE_FOLDER_MULTI,
    PERM_DOWNLOAD_FILE,
    PERM_DOWNLOAD_FILES_MULTI,
    PERM_DOWNLOAD_FOLDER,
    PERM_EDIT_FILE_ACL,
    PERM_PREVIEW,
    PERM_UPLOAD_FILES,
    PERM_UPLOAD_FOLDER,
}))

# Роли с правом редактирования ACL (в т.ч. кастомные в БД без галочки в UI)
ACL_EDIT_ROLE_ALIASES = frozenset({
    ROLE_ADMIN,
    ROLE_STORAGE_ADMIN,
    ROLE_STORAGE_EDITOR,
    # legacy
    'editor',
    'storage.admin',
    'storage-admin',
})


def _normalize_role_key(role_name: str) -> str:
    return normalize_role_name(role_name).replace('_', '.')


def role_implies_acl_edit(role_name: str = None) -> bool:
    """Роль уровня storage/admin с правом менять ACL объектов."""
    key = _normalize_role_key(role_name if role_name is not None else _role())
    if key in {_normalize_role_key(a) for a in ACL_EDIT_ROLE_ALIASES}:
        return True
    return 'storage' in key and 'admin' in key


def _role():
    return session.get('role')


def _session_bucket_roles():
    raw = session.get('bucket_roles')
    return raw if isinstance(raw, dict) else {}


def resolve_role_for_bucket(bucket_id=None):
    """
    Эффективная роль пользователя для бакета:
    grant из user_roles → иначе default role из session.
    """
    default_role = _role()
    if not bucket_id:
        return default_role
    if is_full_storage_role(default_role):
        return default_role
    bid = (bucket_id or '').strip()
    if not bid:
        return default_role
    grants = _session_bucket_roles()
    if bid in grants:
        return grants[bid]
    for grant_bid, grant_role in grants.items():
        if grant_bid and grant_bid == bid:
            return grant_role
    return default_role


def _permissions_list_for_role(role_name):
    """
    Права роли: из таблицы roles (кастомные и отредактированные в UI),
    иначе из ROLE_PERMISSIONS.
    """
    if not role_name:
        return []
    role_name = normalize_role_name(role_name)
    try:
        if getattr(g, "_cached_role_perm_name", None) == role_name and hasattr(
            g, "_cached_role_perm_list"
        ):
            return g._cached_role_perm_list
    except RuntimeError:
        pass
    out = []
    from_db = False
    try:
        from db import get_role

        row = get_role(role_name)
        if row:
            from_db = True
            perms = row.get("permissions")
            if isinstance(perms, str):
                perms = json.loads(perms) if perms else []
            if isinstance(perms, list):
                out = perms
    except Exception:
        pass
    if not from_db:
        out = list(ROLE_PERMISSIONS.get(role_name, ()))
    try:
        g._cached_role_perm_name = role_name
        g._cached_role_perm_list = out
    except RuntimeError:
        pass
    return out


def permissions_for_role(role_name):
    """Публичный список permissions для роли (с учётом ACL alias)."""
    perms = list(_permissions_list_for_role(role_name))
    if role_implies_acl_edit(role_name) and PERM_EDIT_FILE_ACL not in perms:
        perms.append(PERM_EDIT_FILE_ACL)
    return perms


def build_bucket_permissions_map(bucket_roles):
    """bucket_id → permissions[] для ответа check-auth."""
    if not isinstance(bucket_roles, dict):
        return {}
    out = {}
    for bucket_id, role_name in bucket_roles.items():
        bid = (bucket_id or '').strip()
        role = (role_name or '').strip()
        if bid and role:
            out[bid] = permissions_for_role(role)
    return out


def _has_permission(perm, bucket_id=None):
    role_name = resolve_role_for_bucket(bucket_id)
    if not role_name:
        return False
    if perm == PERM_EDIT_FILE_ACL and role_implies_acl_edit(role_name):
        return True
    return perm in _permissions_list_for_role(role_name)


def get_current_permissions(bucket_id=None):
    """Список прав текущего пользователя (для передачи во фронт)."""
    role_name = resolve_role_for_bucket(bucket_id)
    return permissions_for_role(role_name)


# Функции проверки прав (используются в app.py)
def role_upload_files(bucket_id=None):
    return _has_permission(PERM_UPLOAD_FILES, bucket_id)


def role_upload_folder(bucket_id=None):
    return _has_permission(PERM_UPLOAD_FOLDER, bucket_id)


def role_create_folder(bucket_id=None):
    return _has_permission(PERM_CREATE_FOLDER, bucket_id)


def role_delete_file(bucket_id=None):
    return _has_permission(PERM_DELETE_FILE, bucket_id)


def role_delete_folder(bucket_id=None):
    return _has_permission(PERM_DELETE_FOLDER, bucket_id)


def role_download_file(bucket_id=None):
    return _has_permission(PERM_DOWNLOAD_FILE, bucket_id)


def role_download_folder(bucket_id=None):
    return _has_permission(PERM_DOWNLOAD_FOLDER, bucket_id)


def role_download_files_multi(bucket_id=None):
    return _has_permission(PERM_DOWNLOAD_FILES_MULTI, bucket_id)


def role_delete_folder_multi(bucket_id=None):
    return _has_permission(PERM_DELETE_FOLDER_MULTI, bucket_id)


def role_delete_files_multi(bucket_id=None):
    return _has_permission(PERM_DELETE_FILES_MULTI, bucket_id)


def role_copy_file(bucket_id=None):
    return _has_permission(PERM_COPY_FILE, bucket_id)


def role_copy_folder(bucket_id=None):
    return _has_permission(PERM_COPY_FOLDER, bucket_id)


def role_copy_files_multi(bucket_id=None):
    return _has_permission(PERM_COPY_FILES_MULTI, bucket_id)


def role_copy_folder_multi(bucket_id=None):
    return _has_permission(PERM_COPY_FOLDER_MULTI, bucket_id)


def role_move_file(bucket_id=None):
    return _has_permission(PERM_MOVE_FILE, bucket_id)


def role_move_folder(bucket_id=None):
    return _has_permission(PERM_MOVE_FOLDER, bucket_id)


def role_move_files_multi(bucket_id=None):
    return _has_permission(PERM_MOVE_FILES_MULTI, bucket_id)


def role_move_folder_multi(bucket_id=None):
    return _has_permission(PERM_MOVE_FOLDER_MULTI, bucket_id)


def role_edit_file_acl(bucket_id=None):
    return _has_permission(PERM_EDIT_FILE_ACL, bucket_id) or role_implies_acl_edit(
        resolve_role_for_bucket(bucket_id)
    )


def role_add_bucket(bucket_id=None):
    return _has_permission(PERM_ADD_BUCKET, bucket_id)


def role_preview(bucket_id=None):
    return _has_permission(PERM_PREVIEW, bucket_id)
