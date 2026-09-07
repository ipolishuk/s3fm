"""Шифрование чувствительных полей at-rest (Fernet, ключ из APP_SECRETS_KEY / APP_SECRET_KEY)."""

from __future__ import annotations

import base64
import hashlib
import os
from functools import lru_cache
from typing import Optional

ENC_PREFIX = 'enc:v1:'


def _allow_insecure_dev() -> bool:
    return os.environ.get('ALLOW_INSECURE_DEV_SECRET', '').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )


@lru_cache(maxsize=1)
def _fernet():
    try:
        from cryptography.fernet import Fernet
    except ImportError as e:
        raise RuntimeError(
            'cryptography package is required for secret encryption. '
            'Install: pip install cryptography',
        ) from e

    raw = (os.environ.get('APP_SECRETS_KEY') or os.environ.get('APP_SECRET_KEY') or '').strip()
    if not raw:
        if _allow_insecure_dev():
            raw = 'dev-insecure-secret-not-for-production'
        else:
            raise RuntimeError(
                'APP_SECRETS_KEY or APP_SECRET_KEY is required to encrypt bucket secrets',
            )
    digest = hashlib.sha256(raw.encode('utf-8')).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def is_encrypted(value: Optional[str]) -> bool:
    return bool(value) and str(value).startswith(ENC_PREFIX)


def encrypt_secret(plaintext: Optional[str]) -> Optional[str]:
    """Зашифровать секрет для хранения в БД. Пустые значения и уже encrypted — без изменений."""
    if plaintext is None:
        return None
    text = str(plaintext)
    if not text:
        return text
    if is_encrypted(text):
        return text
    token = _fernet().encrypt(text.encode('utf-8')).decode('ascii')
    return ENC_PREFIX + token


def decrypt_secret(stored: Optional[str]) -> Optional[str]:
    """Расшифровать секрет из БД. Plaintext (legacy) возвращается как есть."""
    if stored is None:
        return None
    text = str(stored)
    if not text or not is_encrypted(text):
        return text
    token = text[len(ENC_PREFIX):]
    try:
        return _fernet().decrypt(token.encode('ascii')).decode('utf-8')
    except Exception:
        # Неверный ключ / повреждённые данные — пусть вызывающий код увидит сбой S3,
        # а не «тихий» plaintext с префиксом.
        raise RuntimeError('Failed to decrypt stored secret (check APP_SECRETS_KEY / APP_SECRET_KEY)')
