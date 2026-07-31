from __future__ import annotations

import configparser
import io
import os
import stat
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path

from filelock import FileLock, Timeout

from harbor_hf.config import harbor_hf_config_path

_TOKEN_STORE_ENVIRONMENT_VARIABLE = "HARBOR_HF_TOKEN_STORE"
_MAX_TOKEN_STORE_BYTES = 1024 * 1024
_MAX_TOKEN_COUNT = 256
_MAX_TOKEN_BYTES = 16 * 1024
_TOKEN_STORE_LOCK_TIMEOUT_SECONDS = 10


class _CaseSensitiveConfigParser(configparser.ConfigParser):
    def optionxform(self, optionstr: str) -> str:
        return optionstr


def harbor_hf_token_store_path(
    environ: Mapping[str, str] | None = None,
) -> Path:
    values = os.environ if environ is None else environ
    explicit = values.get(_TOKEN_STORE_ENVIRONMENT_VARIABLE)
    if explicit:
        return Path(explicit).expanduser()
    return harbor_hf_config_path(values).parent / "stored_tokens"


def load_harbor_hf_tokens(path: Path | None = None) -> dict[str, str]:
    source = harbor_hf_token_store_path() if path is None else path
    if not source.exists() and not source.is_symlink():
        return {}
    _validate_private_directory(source.parent)
    _validate_token_store_file(source)
    payload = source.read_bytes()
    if len(payload) > _MAX_TOKEN_STORE_BYTES:
        raise ValueError("Harbor HF token store exceeds the 1 MiB limit")
    return _parse_token_store(source, payload)


def save_harbor_hf_tokens(
    tokens: Mapping[str, str],
    path: Path | None = None,
) -> Path:
    normalized = _validated_tokens(tokens)
    destination = harbor_hf_token_store_path() if path is None else path
    with _token_store_lock(destination):
        return _save_harbor_hf_tokens_unlocked(normalized, destination)


def store_harbor_hf_token(
    token_name: str,
    token: str,
    *,
    replace: bool = False,
    path: Path | None = None,
) -> Path:
    _validate_token_name(token_name)
    _validate_token_value(token)
    destination = harbor_hf_token_store_path() if path is None else path
    with _token_store_lock(destination):
        tokens = load_harbor_hf_tokens(destination)
        if token_name in tokens and not replace:
            raise ValueError(
                f"Harbor HF token {token_name!r} is already saved; "
                "pass --force to replace it"
            )
        tokens[token_name] = token
        return _save_harbor_hf_tokens_unlocked(tokens, destination)


def remove_harbor_hf_token(
    token_name: str,
    *,
    path: Path | None = None,
) -> Path:
    _validate_token_name(token_name)
    destination = harbor_hf_token_store_path() if path is None else path
    with _token_store_lock(destination):
        tokens = load_harbor_hf_tokens(destination)
        if token_name not in tokens:
            raise ValueError(f"Harbor HF token {token_name!r} is not saved")
        del tokens[token_name]
        return _save_harbor_hf_tokens_unlocked(tokens, destination)


def _validated_tokens(tokens: Mapping[str, str]) -> dict[str, str]:
    if len(tokens) > _MAX_TOKEN_COUNT:
        raise ValueError("Harbor HF token store exceeds the 256-token limit")
    normalized: dict[str, str] = {}
    for token_name, token in tokens.items():
        _validate_token_name(token_name)
        _validate_token_value(token)
        normalized[token_name] = token
    return normalized


def _save_harbor_hf_tokens_unlocked(
    tokens: Mapping[str, str], destination: Path
) -> Path:
    if destination.exists() or destination.is_symlink():
        _validate_token_store_file(destination)
    parser = _token_parser()
    for token_name in sorted(tokens):
        parser.add_section(token_name)
        parser.set(token_name, "hf_token", tokens[token_name])
    buffer = io.StringIO()
    parser.write(buffer)
    payload = buffer.getvalue().encode("utf-8")
    if len(payload) > _MAX_TOKEN_STORE_BYTES:
        raise ValueError("Harbor HF token store exceeds the 1 MiB limit")
    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(
            prefix=".stored-tokens-", dir=destination.parent
        )
        temporary = Path(name)
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        temporary = None
        os.chmod(destination, 0o600)
        _sync_directory(destination.parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


@contextmanager
def _token_store_lock(destination: Path) -> Iterator[None]:
    _prepare_private_directory(destination.parent)
    lock_path = destination.with_name(f".{destination.name}.lock")
    lock = FileLock(
        lock_path,
        timeout=_TOKEN_STORE_LOCK_TIMEOUT_SECONDS,
        mode=0o600,
    )
    try:
        with lock:
            os.chmod(lock_path, 0o600)
            yield
    except Timeout as error:
        raise ValueError(
            f"timed out waiting for Harbor HF token store lock: {lock_path}"
        ) from error


def _parse_token_store(source: Path, payload: bytes) -> dict[str, str]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(
            f"invalid Harbor HF token store at {source}: not UTF-8"
        ) from error
    parser = _token_parser()
    try:
        parser.read_string(text)
    except configparser.Error as error:
        raise ValueError(
            f"invalid Harbor HF token store at {source}: {error}"
        ) from error
    if parser.defaults():
        raise ValueError(
            f"invalid Harbor HF token store at {source}: DEFAULT values are forbidden"
        )
    sections = parser.sections()
    if len(sections) > _MAX_TOKEN_COUNT:
        raise ValueError("Harbor HF token store exceeds the 256-token limit")
    tokens: dict[str, str] = {}
    for token_name in sections:
        _validate_token_name(token_name)
        fields = dict(parser.items(token_name, raw=True))
        if set(fields) != {"hf_token"}:
            raise ValueError(
                f"invalid Harbor HF token store at {source}: token {token_name!r} "
                "must contain only hf_token"
            )
        token = fields["hf_token"]
        _validate_token_value(token)
        tokens[token_name] = token
    return tokens


def _token_parser() -> configparser.ConfigParser:
    return _CaseSensitiveConfigParser(interpolation=None, strict=True)


def _validate_token_name(token_name: str) -> None:
    if not token_name or token_name != token_name.strip():
        raise ValueError(
            "Harbor HF token name must be nonempty without outer whitespace"
        )
    if len(token_name) > 256:
        raise ValueError("Harbor HF token name exceeds the 256-character limit")
    if token_name == configparser.DEFAULTSECT:
        raise ValueError("Harbor HF token name cannot be DEFAULT")
    if any(ord(character) < 32 or ord(character) == 127 for character in token_name):
        raise ValueError("Harbor HF token name cannot contain control characters")


def _validate_token_value(token: str) -> None:
    if not token or token != token.strip():
        raise ValueError("Harbor HF token value must be nonempty without whitespace")
    if len(token.encode("utf-8")) > _MAX_TOKEN_BYTES:
        raise ValueError("Harbor HF token value exceeds the 16 KiB limit")
    if any(ord(character) < 32 or ord(character) == 127 for character in token):
        raise ValueError("Harbor HF token value cannot contain control characters")


def _prepare_private_directory(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"Harbor HF token store directory cannot be a symlink: {path}")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    _validate_private_directory(path)


def _validate_private_directory(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"Harbor HF token store directory cannot be a symlink: {path}")
    metadata = path.stat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"Harbor HF token store parent must be a directory: {path}")
    if metadata.st_mode & 0o077:
        raise ValueError(
            f"Harbor HF token store directory permissions must be 0700: {path}"
        )
    getuid = getattr(os, "getuid", None)
    if getuid is not None and metadata.st_uid != getuid():
        raise ValueError(
            f"Harbor HF token store directory must be owned by the current user: {path}"
        )


def _validate_token_store_file(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"Harbor HF token store cannot be a symlink: {path}")
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"Harbor HF token store must be a regular file: {path}")
    if metadata.st_mode & 0o077:
        raise ValueError(f"Harbor HF token store permissions must be 0600: {path}")
    getuid = getattr(os, "getuid", None)
    if getuid is not None and metadata.st_uid != getuid():
        raise ValueError(
            f"Harbor HF token store must be owned by the current user: {path}"
        )


def _sync_directory(path: Path) -> None:
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if directory_flag is None:
        return
    descriptor = os.open(path, os.O_RDONLY | directory_flag)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
