from uuid import UUID

# Improved JSON encoder that properly handles floats and other types


def enhanced_json_encoder(obj):
    """
    Custom JSON encoder that handles various types properly:
    - Preserves floating - point precision
    - Handles UUID conversion
    - Handles datetime objects
    - Other special types
    """
    if isinstance(obj, float):
        # Return as a float, not a string
        return float(obj)
    elif isinstance(obj, UUID):
        # Convert UUIDs to string
        return str(obj)
    elif hasattr(obj, "isoformat"):
        # Handle datetime objects
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")
