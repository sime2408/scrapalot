"""
Model name utility functions for normalizing and formatting model names.
"""

import re


def normalize_model_display_name(model_name: str) -> str:
    """
    Normalize model name for UI display by creating a clean, human-readable display name.
    This works in conjunction with the frontend getSimplifiedName() function.

    Args:
        model_name: The raw model name to normalize

    Returns:
        A normalized, human-readable display name
    """
    if not model_name:
        return "Unknown Model"

    display_name = model_name

    # Remove common file extensions first
    display_name = display_name.replace(".gguf", "").replace(".bin", "").replace(".safetensors", "")

    # Remove common quantization and technical suffixes that the frontend also handles
    # This ensures we don't have double-processing
    display_name = re.sub(
        r"-q\d+_K_M$|-q\d+_k$|-q\d+k$|-q\d+_0$|-q\d+$",
        "",
        display_name,
        flags=re.IGNORECASE,
    )
    display_name = re.sub(r"-(fp16|fp32|int8|int4)$", "", display_name, flags=re.IGNORECASE)

    # Keep instruction/chat suffixes but make them more readable
    display_name = re.sub(r"-instruct$", " Instruct", display_name, flags=re.IGNORECASE)
    display_name = re.sub(r"-chat$", " Chat", display_name, flags=re.IGNORECASE)

    # Replace hyphens and underscores with spaces for better readability
    display_name = display_name.replace("-", " ").replace("_", " ")

    # Clean up multiple spaces
    display_name = re.sub(r"\s+", " ", display_name)

    # Capitalize a first letter of each word for proper presentation
    display_name = " ".join(word.capitalize() for word in display_name.split())

    return display_name.strip()
