# -*- coding: utf-8 -*-
"""Загрузка и рендер справки (документация и поддержка) из Markdown."""

import os

import markdown

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
HELP_DIR = os.path.join(_APP_DIR, 'help')
HELP_DOCS_DIR = os.path.join(HELP_DIR, 'docs')
HELP_SUPPORT_DIR = os.path.join(HELP_DIR, 'support')
SUPPORTED_HELP_LOCALES = ('en', 'ru')
DEFAULT_HELP_LOCALE = 'en'

HELP_DOC_SECTION_ORDER = (
    'overview',
    'buckets',
    'files',
    'search',
    'selection',
    'file_info',
    'permissions',
    'interface',
    'admin',
)

HELP_SUPPORT_SECTION_ORDER = (
    'intro',
    'contacts',
    'reporting',
)

_MD = markdown.Markdown(
    extensions=['sane_lists', 'tables', 'fenced_code', 'nl2br'],
    output_format='html5',
)


def _split_title_and_body(text):
    lines = text.splitlines()
    if lines and lines[0].startswith('# '):
        title = lines[0][2:].strip()
        body = '\n'.join(lines[1:]).lstrip('\n')
        return title, body
    return '', text


def _render_markdown(body):
    if not body.strip():
        return ''
    _MD.reset()
    return _MD.convert(body)


def _load_section(locale, slug, base_dir):
    path = os.path.join(base_dir, locale, f'{slug}.md')
    if not os.path.isfile(path) and locale != DEFAULT_HELP_LOCALE:
        path = os.path.join(base_dir, DEFAULT_HELP_LOCALE, f'{slug}.md')
    if not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as fh:
        raw = fh.read()
    title, body = _split_title_and_body(raw)
    if not title:
        title = slug.replace('_', ' ').title()
    return {
        'id': slug,
        'title': title,
        'html': _render_markdown(body),
    }


def _load_sections(locale, base_dir, section_order):
    loc = locale if locale in SUPPORTED_HELP_LOCALES else DEFAULT_HELP_LOCALE
    sections = []
    for slug in section_order:
        section = _load_section(loc, slug, base_dir)
        if section:
            sections.append(section)
    return sections


def get_help_documentation(locale):
    """Секции документации для локали (fallback на en)."""
    return _load_sections(locale, HELP_DOCS_DIR, HELP_DOC_SECTION_ORDER)


def get_help_support(locale):
    """Секции поддержки для локали (fallback на en)."""
    return _load_sections(locale, HELP_SUPPORT_DIR, HELP_SUPPORT_SECTION_ORDER)
