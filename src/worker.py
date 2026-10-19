#!/usr/bin/env python3
"""Отдельный процесс для copy/move/delete/acl/bucket_size.

  OPERATION_WORKER_MODE=external  — web только enqueue
  python worker.py                — этот процесс забирает pending из PostgreSQL

Переменные:
  OPERATION_WORKER_POLL_SEC  — пауза между poll (по умолчанию 1.0)
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    # Гарантируем, что src/ на path при запуске из корня репо
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)

    try:
        from db import get_connection
        conn = get_connection()
        conn.close()
    except Exception as exc:
        print(f'worker: database unavailable: {exc}', file=sys.stderr)
        return 1

    from worker_jobs import worker_loop

    try:
        poll = float(os.environ.get('OPERATION_WORKER_POLL_SEC', '1.0'))
    except (TypeError, ValueError):
        poll = 1.0
    worker_loop(poll_sec=max(0.2, poll))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
