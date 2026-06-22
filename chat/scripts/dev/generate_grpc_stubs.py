#!/usr/bin/env python3
"""
Generate Python gRPC stubs from proto files.

This script generates Python protocol buffer and gRPC files from the
proto definitions. Proto files should be in src/main/service/bridge/proto/src/
for portability.

Usage:
    python scripts/dev/generate_grpc_stubs.py              # Generate stubs
    python scripts/dev/generate_grpc_stubs.py --copy       # Copy protos from backend first
    python scripts/dev/generate_grpc_stubs.py --check      # Check if protos exist

Requirements:
    pip install grpcio-tools
"""

import argparse
from pathlib import Path
import shutil
import sys


def get_project_root() -> Path:
    """Get the scrapalot-chat project root directory."""
    script_dir = Path(__file__).parent
    return script_dir.parent


def get_proto_source_dir() -> Path:
    """
    Get the proto source directory.

    First checks for local proto/src directory, then falls back to scrapalot-backend.
    This allows the Python project to have its own copy of proto files for portability.
    """
    project_root = get_project_root()

    # First, check for local proto source directory (recommended for portability)
    local_proto = project_root / "src" / "main" / "service" / "bridge" / "proto" / "src"
    if local_proto.exists() and any(local_proto.glob("*.proto")):
        print(f"✓ Using local proto source: {local_proto}")
        return local_proto

    # Fall back to scrapalot-backend (development mode)
    backend_proto = project_root.parent / "scrapalot-backend" / "src" / "main" / "proto"
    if backend_proto.exists() and any(backend_proto.glob("*.proto")):
        print(f"✓ Using scrapalot-backend proto source: {backend_proto}")
        print(f"⚠ Recommendation: Copy proto files to {local_proto} for better portability")
        print(f"  Run: mkdir -p {local_proto} && cp {backend_proto}/*.proto {local_proto}/")
        return backend_proto

    # Neither location has proto files - provide helpful error
    error_msg = (
        "❌ Proto files not found in any expected location!\n\n"
        f"Checked locations:\n"
        f"  1. Local (recommended): {local_proto}\n"
        f"  2. Backend (fallback):  {backend_proto}\n\n"
        "To fix this issue, choose one of the following:\n\n"
        "Option 1 (Recommended - Portable):\n"
        f"  mkdir -p {local_proto}\n"
        f"  # Copy proto files from scrapalot-backend:\n"
        f"  cp path/to/scrapalot-backend/src/main/proto/*.proto {local_proto}/\n\n"
        "Option 2 (Development - Requires scrapalot-backend):\n"
        f"  # Clone scrapalot-backend in parent directory:\n"
        f"  cd {project_root.parent}\n"
        "  git clone https://github.com/sime2408/scrapalot-backend.git\n\n"
        "Option 3 (CI/CD - Bundle proto files):\n"
        "  # Ensure proto files are committed to scrapalot-chat repository\n"
        f"  # in {local_proto}/ directory\n"
    )
    raise FileNotFoundError(error_msg)


def get_output_dir() -> Path:
    """Get the output directory for generated files."""
    return get_project_root() / "src" / "main" / "service" / "bridge" / "proto"


def get_local_proto_dir() -> Path:
    """Get the local proto source directory."""
    return get_project_root() / "src" / "main" / "service" / "bridge" / "proto" / "src"


def get_backend_proto_dir() -> Path:
    """Get the scrapalot-backend proto directory."""
    return get_project_root().parent / "scrapalot-backend" / "src" / "main" / "proto"


def copy_protos_from_backend() -> bool:
    """
    Copy proto files from scrapalot-backend to local directory.

    Returns:
        True if copy was successful, False otherwise.
    """
    backend_dir = get_backend_proto_dir()
    local_dir = get_local_proto_dir()

    if not backend_dir.exists():
        print(f"❌ Backend proto directory not found: {backend_dir}")
        print("\nTo fix this:")
        print("  1. Clone scrapalot-backend in parent directory:")
        print(f"     cd {get_project_root().parent}")
        print("     git clone https://github.com/sime2408/scrapalot-backend.git")
        print("  2. Or manually copy proto files to:")
        print(f"     {local_dir}")
        return False

    proto_files = list(backend_dir.glob("*.proto"))
    if not proto_files:
        print(f"❌ No .proto files found in: {backend_dir}")
        return False

    # Create local directory if needed
    local_dir.mkdir(parents=True, exist_ok=True)

    # Copy proto files
    print(f"Copying {len(proto_files)} proto files from backend...")
    for proto_file in proto_files:
        dest = local_dir / proto_file.name
        shutil.copy2(proto_file, dest)
        print(f"  ✓ Copied: {proto_file.name}")

    print(f"\nProto files copied to: {local_dir}")
    print("   These files should be committed to the repository for CI/CD portability.")
    return True


def check_proto_availability() -> dict:
    """
    Check where proto files are available.

    Returns:
        Dict with 'local' and 'backend' boolean keys.
    """
    local_dir = get_local_proto_dir()
    backend_dir = get_backend_proto_dir()

    return {
        "local": local_dir.exists() and any(local_dir.glob("*.proto")),
        "backend": backend_dir.exists() and any(backend_dir.glob("*.proto")),
        "local_path": local_dir,
        "backend_path": backend_dir,
    }


def check_grpcio_tools():
    """Check if grpcio-tools is installed."""
    try:
        import grpc_tools  # noqa: F401

        return True
    except ImportError:
        return False


def generate_stubs():
    """Generate Python gRPC stubs from proto files."""
    proto_source_dir = get_proto_source_dir()
    output_dir = get_output_dir()

    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)

    # Proto files to generate (in order - common first since others depend on it)
    proto_files = [
        "common.proto",
        "subscription_service.proto",
        "settings_service.proto",
        "auth_service.proto",
        "workspace_service.proto",
        "collection_service.proto",
        "document_service.proto",
        "events_service.proto",
    ]

    # Check which proto files exist
    available_protos = []
    for proto_file in proto_files:
        proto_path = proto_source_dir / proto_file
        if proto_path.exists():
            available_protos.append(proto_file)
        else:
            print(f"Warning: Proto file not found, skipping: {proto_path}")

    if not available_protos:
        raise FileNotFoundError("No proto files found!")

    # Generate Python files using grpc_tools
    from grpc_tools import protoc

    for proto_file in available_protos:
        print(f"Generating stubs for {proto_file}...")

        # Run protoc
        result = protoc.main(
            [
                "grpc_tools.protoc",
                f"--proto_path={proto_source_dir}",
                f"--python_out={output_dir}",
                f"--grpc_python_out={output_dir}",
                str(proto_source_dir / proto_file),
            ]
        )

        if result != 0:
            raise RuntimeError(f"Failed to generate stubs for {proto_file}")

    # Fix imports in generated files
    fix_generated_imports(output_dir)

    print(f"\nGenerated files in {output_dir}:")
    for f in sorted(output_dir.glob("*.py")):
        if f.name != "__init__.py" and f.name != "src":
            print(f"  - {f.name}")


def fix_generated_imports(output_dir: Path):
    """Fix imports in generated gRPC files to use relative imports."""
    # Fix all *_pb2_grpc.py files
    for py_file in output_dir.glob("*_pb2_grpc.py"):
        content = py_file.read_text()

        # Fix import for common_pb2
        content = content.replace("import common_pb2", "from . import common_pb2")

        # Fix imports for all service pb2 files
        for service in [
            "subscription_service",
            "settings_service",
            "auth_service",
            "workspace_service",
            "collection_service",
            "document_service",
            "events_service",
        ]:
            content = content.replace(f"import {service}_pb2", f"from . import {service}_pb2")

        py_file.write_text(content)

    # Fix all *_pb2.py files (not grpc) - they may import common_pb2
    for py_file in output_dir.glob("*_pb2.py"):
        if "_grpc" in py_file.name:
            continue

        content = py_file.read_text()

        # Fix import for common_pb2
        content = content.replace("import common_pb2", "from . import common_pb2")

        py_file.write_text(content)

    # Rename files to shorter names for easier import
    renames = [
        ("subscription_service_pb2.py", "subscription_pb2.py"),
        ("subscription_service_pb2_grpc.py", "subscription_pb2_grpc.py"),
        ("settings_service_pb2.py", "settings_pb2.py"),
        ("settings_service_pb2_grpc.py", "settings_pb2_grpc.py"),
        ("auth_service_pb2.py", "auth_pb2.py"),
        ("auth_service_pb2_grpc.py", "auth_pb2_grpc.py"),
        ("workspace_service_pb2.py", "workspace_pb2.py"),
        ("workspace_service_pb2_grpc.py", "workspace_pb2_grpc.py"),
        ("collection_service_pb2.py", "collection_pb2.py"),
        ("collection_service_pb2_grpc.py", "collection_pb2_grpc.py"),
        ("document_service_pb2.py", "document_pb2.py"),
        ("document_service_pb2_grpc.py", "document_pb2_grpc.py"),
        ("events_service_pb2.py", "events_pb2.py"),
        ("events_service_pb2_grpc.py", "events_pb2_grpc.py"),
    ]

    for old_name, new_name in renames:
        old_path = output_dir / old_name
        new_path = output_dir / new_name

        if old_path.exists():
            # Read content and fix self-references in grpc files
            content = old_path.read_text()

            # Fix internal references for renamed files
            if "_grpc" in old_name:
                # Update import to use new module name
                base_old = old_name.replace("_pb2_grpc.py", "_pb2")
                base_new = new_name.replace("_pb2_grpc.py", "_pb2")
                content = content.replace(f"from . import {base_old}", f"from . import {base_new}")

            # Remove old target if exists
            if new_path.exists():
                new_path.unlink()

            # Write with fixed content and rename
            old_path.write_text(content)
            old_path.rename(new_path)
            print(f"  Renamed: {old_name} -> {new_name}")


def update_proto_init(output_dir: Path):
    """Update the __init__.py file in proto directory to export all modules."""
    init_file = output_dir / "__init__.py"

    content = '''"""
Auto-generated gRPC protocol buffer modules.

Generated by scripts/dev/generate_grpc_stubs.py from proto files.
Do not edit manually - regenerate using the script.

Available modules:
    - common_pb2: Common types (UUID, Timestamp, StatusResponse, etc.)
    - subscription_pb2, subscription_pb2_grpc: Subscription service
    - settings_pb2, settings_pb2_grpc: Settings service
    - auth_pb2, auth_pb2_grpc: Auth service
    - workspace_pb2, workspace_pb2_grpc: Workspace service
    - collection_pb2, collection_pb2_grpc: Collection service
    - document_pb2, document_pb2_grpc: Document service
    - events_pb2, events_pb2_grpc: Events service
"""

# These are generated by grpc_tools and may have type checking issues
# that are safe to ignore

try:
    from . import common_pb2
except ImportError:
    common_pb2 = None  # type: ignore

try:
    from . import subscription_pb2
    from . import subscription_pb2_grpc
except ImportError:
    subscription_pb2 = None  # type: ignore
    subscription_pb2_grpc = None  # type: ignore

try:
    from . import settings_pb2
    from . import settings_pb2_grpc
except ImportError:
    settings_pb2 = None  # type: ignore
    settings_pb2_grpc = None  # type: ignore

try:
    from . import auth_pb2
    from . import auth_pb2_grpc
except ImportError:
    auth_pb2 = None  # type: ignore
    auth_pb2_grpc = None  # type: ignore

try:
    from . import workspace_pb2
    from . import workspace_pb2_grpc
except ImportError:
    workspace_pb2 = None  # type: ignore
    workspace_pb2_grpc = None  # type: ignore

try:
    from . import collection_pb2
    from . import collection_pb2_grpc
except ImportError:
    collection_pb2 = None  # type: ignore
    collection_pb2_grpc = None  # type: ignore

try:
    from . import document_pb2
    from . import document_pb2_grpc
except ImportError:
    document_pb2 = None  # type: ignore
    document_pb2_grpc = None  # type: ignore

try:
    from . import events_pb2
    from . import events_pb2_grpc
except ImportError:
    events_pb2 = None  # type: ignore
    events_pb2_grpc = None  # type: ignore

__all__ = [
    "common_pb2",
    "subscription_pb2",
    "subscription_pb2_grpc",
    "settings_pb2",
    "settings_pb2_grpc",
    "auth_pb2",
    "auth_pb2_grpc",
    "workspace_pb2",
    "workspace_pb2_grpc",
    "collection_pb2",
    "collection_pb2_grpc",
    "document_pb2",
    "document_pb2_grpc",
    "events_pb2",
    "events_pb2_grpc",
]
'''

    init_file.write_text(content)
    print(f"  Updated: {init_file.name}")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Generate Python gRPC stubs from proto files.",
        epilog="For CI/CD, ensure proto files are committed to src/main/service/bridge/proto/src/",
    )
    parser.add_argument(
        "--copy",
        action="store_true",
        help="Copy proto files from scrapalot-backend to local directory first",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check proto file availability without generating stubs",
    )
    args = parser.parse_args()

    # Check mode - just report status
    if args.check:
        print("Proto File Availability Check")
        print("=" * 50)
        status = check_proto_availability()

        print(f"\nLocal directory: {status['local_path']}")
        if status["local"]:
            proto_count = len(list(status["local_path"].glob("*.proto")))
            print(f"  Available ({proto_count} proto files)")
        else:
            print("  ❌ Not found or empty")

        print(f"\nBackend directory: {status['backend_path']}")
        if status["backend"]:
            proto_count = len(list(status["backend_path"].glob("*.proto")))
            print(f"  Available ({proto_count} proto files)")
        else:
            print("  ❌ Not found or empty")

        if not status["local"] and not status["backend"]:
            print("\n⚠️  No proto files found anywhere!")
            print("   Run with --copy to copy from scrapalot-backend.")
            sys.exit(1)
        elif not status["local"] and status["backend"]:
            print("\n⚠️  Proto files only in backend (not portable for CI/CD)")
            print("   Run with --copy to copy to local directory.")
            sys.exit(0)
        else:
            print("\nProto files are available locally (CI/CD ready)")
            sys.exit(0)

    # Copy mode - copy protos from backend
    if args.copy:
        print("Copying proto files from scrapalot-backend...")
        print("=" * 50)
        if not copy_protos_from_backend():
            sys.exit(1)
        print()  # Blank line before generation

    # Generate stubs
    print("Generating Python gRPC stubs...")
    print("=" * 50)

    # Check for grpcio-tools
    if not check_grpcio_tools():
        print("❌ Error: grpcio-tools is not installed.")
        print("   Install it with: pip install grpcio-tools")
        sys.exit(1)

    try:
        generate_stubs()
        update_proto_init(get_output_dir())
        print("\n" + "=" * 50)
        print("Successfully generated gRPC stubs!")
        print("\nYou can now use gRPC mode by setting:")
        print("  MICROSERVICES_MODE=grpc")
        print("or in config.yaml:")
        print("  microservices:")
        print("    mode: grpc")
    except FileNotFoundError as e:
        print(f"\n{e}")
        # CI/CD-specific guidance
        print("\n" + "=" * 50)
        print("CI/CD Note: Proto files must be committed to the repository.")
        print("Run locally: python scripts/dev/generate_grpc_stubs.py --copy")
        print("Then commit the proto files in src/main/service/bridge/proto/src/")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
