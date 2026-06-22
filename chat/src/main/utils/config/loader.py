from functools import lru_cache
import os
import re
from typing import Any

import dotenv
import yaml
from yaml.loader import SafeLoader

from src.main.utils.core.logger import get_logger

# Load environment variables from the .env file if present
dotenv.load_dotenv()

# Initialize logger
logger = get_logger(__name__)

# Get the path of the config file (default: config.yaml in configs directory)
CONFIG_DIR = os.getenv("CONFIG_DIR", "configs")
CONFIG_FILE = os.getenv("CONFIG_FILE", "config.yaml")
CONFIG_PATH = os.path.join(CONFIG_DIR, CONFIG_FILE)
SECRETS_FILE = os.getenv("SECRETS_FILE", "secrets.yaml")
SECRETS_PATH = os.path.join(CONFIG_DIR, SECRETS_FILE)
PROMPTS_FILE = os.getenv("PROMPTS_FILE", "prompts.yaml")
PROMPTS_PATH = os.path.join(CONFIG_DIR, PROMPTS_FILE)
NEW_USERS_CONFIG_FILE = os.getenv("NEW_USERS_CONFIG_FILE", "config-new-users.yaml")
NEW_USERS_CONFIG_PATH = os.path.join(CONFIG_DIR, NEW_USERS_CONFIG_FILE)


# Load secrets from the secrets.yaml file if it exists


def load_secrets(file_secrets=None):
    """
    Load secrets from environment variables and file, with environment variables taking precedence.

    Args:
        file_secrets: Dictionary of secrets loaded from a file (optional)

    Returns:
        Dictionary of resolved secrets
    """
    if file_secrets is None:
        file_secrets = {}

    # Create resolved secrets dict with environment variables taking precedence
    # NOTE: LLM API keys (openai, anthropic, google) are stored in the database
    # (server_settings.system_agent_config), NOT here. Configure via admin UI.
    secrets = {
        "postgres_password": os.getenv("POSTGRES_PASSWORD") or file_secrets.get("postgres_password", "postgres"),
        "redis_password": os.getenv("REDIS_PASSWORD") or file_secrets.get("redis_password", ""),
        "jwt_secret": os.getenv("JWT_SECRET") or file_secrets.get("jwt_secret", ""),
        "neo4j_password": os.getenv("NEO4J_PASSWORD") or file_secrets.get("neo4j_password", ""),
        "serpapi_key": os.getenv("SERPAPI_KEY") or file_secrets.get("serpapi_key", ""),
        "google_search_api_key": os.getenv("GOOGLE_SEARCH_API_KEY") or file_secrets.get("google_search_api_key", ""),
        "google_search_engine_id": os.getenv("GOOGLE_SEARCH_ENGINE_ID") or file_secrets.get("google_search_engine_id", ""),
        "huggingface_token": os.getenv("HUGGINGFACE_TOKEN") or file_secrets.get("huggingface_token", ""),
        "google_oauth_client_secret": os.getenv("GOOGLE_OAUTH_CLIENT_SECRET") or file_secrets.get("google_oauth_client_secret", ""),
        "firecrawl_api_key": os.getenv("FIRECRAWL_API_KEY") or file_secrets.get("firecrawl_api_key", ""),
        "tavily_api_key": os.getenv("TAVILY_API_KEY") or file_secrets.get("tavily_api_key", ""),
        "stripe_secret_key": os.getenv("STRIPE_SECRET_KEY") or file_secrets.get("stripe_secret_key", ""),
        "stripe_webhook_secret": os.getenv("STRIPE_WEBHOOK_SECRET") or file_secrets.get("stripe_webhook_secret", ""),
    }

    # Ensure required secrets are set
    required_secrets = ["postgres_password", "jwt_secret"]
    for secret in required_secrets:
        if not secrets.get(secret):
            logger.warning("Required secret '%s' is not set in environment or secrets file. Using default value.", secret)

    return secrets


# Load secrets from the secrets.yaml file if it exists
try:
    secrets_from_file = {}
    # Get an absolute path to the secret file
    abs_secrets_path = os.path.abspath(SECRETS_PATH)

    if os.path.exists(abs_secrets_path):
        with open(abs_secrets_path, encoding="utf-8") as file:
            secrets_from_file = yaml.safe_load(file) or {}

        # Check if we loaded the jwt_secret specifically
        if "jwt_secret" not in secrets_from_file:
            logger.warning("jwt_secret not found in %s", abs_secrets_path)
            logger.debug("Secrets file contains these keys: %s", list(secrets_from_file.keys()))

        logger.debug("Loaded secrets from %s", abs_secrets_path)
    else:
        logger.warning("Secrets file not found at %s", abs_secrets_path)
        # Try to look for secrets.yaml in the current working directory
        cwd = os.getcwd()
        logger.debug("Current working directory: %s", cwd)
        alt_path = os.path.join(cwd, "configs", "secrets.yaml")
        if os.path.exists(alt_path):
            logger.debug("Found secrets file at alternate path: %s", alt_path)
            try:
                with open(alt_path, encoding="utf-8") as file:
                    secrets_from_file = yaml.safe_load(file) or {}
                logger.debug("Loaded secrets from alternate path: %s", alt_path)
                logger.debug("Secrets file contains these keys: %s", list(secrets_from_file.keys()))
            except Exception as alt_e:
                logger.error("Error loading alternate secrets file: %s", str(alt_e))

except Exception as e:
    logger.error("Error loading secrets file: %s", str(e))
    secrets_from_file = {}

resolved_secrets = load_secrets(secrets_from_file)


# Load prompts from the prompts.yaml file if it exists
try:
    prompts_from_file = {}
    # Get an absolute path to the prompts file
    abs_prompts_path = os.path.abspath(PROMPTS_PATH)

    if os.path.exists(abs_prompts_path):
        with open(abs_prompts_path, encoding="utf-8") as file:
            prompts_from_file = yaml.safe_load(file) or {}
        logger.debug("Loaded prompts from %s", abs_prompts_path)
    else:
        logger.warning("Prompts file not found at %s", abs_prompts_path)
        # Try to look for prompts.yaml in the current working directory
        cwd = os.getcwd()
        logger.debug("Current working directory: %s", cwd)
        alt_path = os.path.join(cwd, "configs", "prompts.yaml")
        if os.path.exists(alt_path):
            logger.debug("Found prompts file at alternate path: %s", alt_path)
            try:
                with open(alt_path, encoding="utf-8") as file:
                    prompts_from_file = yaml.safe_load(file) or {}
                logger.debug("Loaded prompts from alternate path: %s", alt_path)
            except Exception as alt_e:
                logger.error("Error loading alternate prompts file: %s", str(alt_e))
except Exception as e:
    logger.error("Error loading prompts file: %s", str(e))
    prompts_from_file = {}

resolved_prompts = prompts_from_file


# Load new user defaults from the config-new-users.yaml file if it exists
try:
    new_users_config = {}
    # Get an absolute path to the new users config file
    abs_new_users_config_path = os.path.abspath(NEW_USERS_CONFIG_PATH)

    if os.path.exists(abs_new_users_config_path):
        with open(abs_new_users_config_path, encoding="utf-8") as file:
            new_users_config = yaml.safe_load(file) or {}
        logger.debug("Loaded new users config from %s", abs_new_users_config_path)
    else:
        logger.warning("New users config file not found at %s", abs_new_users_config_path)
        # Try to look for config-new-users.yaml in the current working directory
        cwd = os.getcwd()
        logger.debug("Current working directory: %s", cwd)
        alt_path = os.path.join(cwd, "configs", "config-new-users.yaml")
        if os.path.exists(alt_path):
            logger.debug("Found new users config file at alternate path: %s", alt_path)
            try:
                with open(alt_path, encoding="utf-8") as file:
                    new_users_config = yaml.safe_load(file) or {}
                logger.debug("Loaded new users config from alternate path: %s", alt_path)
            except Exception as alt_e:
                logger.error("Error loading alternate new users config file: %s", str(alt_e))
except Exception as e:
    logger.error("Error loading new users config file: %s", str(e))
    new_users_config = {}

resolved_new_users_config = new_users_config


# Process environment variables


def resolve_env_var(value):
    if isinstance(value, str):
        pattern = r"\$\{([^}]+)}"
        match = re.search(pattern, value)
        if match:
            env_var_with_default = match.group(1)
            if ":-" in env_var_with_default:
                env_var, default = env_var_with_default.split(":-")
                return os.environ.get(env_var) or default
            else:
                return os.environ.get(env_var_with_default) or value
    return value


def resolve_nested(data):
    if isinstance(data, dict):
        return {k: resolve_nested(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [resolve_nested(item) for item in data]
    else:
        return resolve_env_var(data)


def ensure_postgres_port(config, log_with_logger=True):
    """
    Ensure the Postgres port is an integer in the config.

    Args:
        config: Configuration dictionary
        log_with_logger: Whether to use logger (True) or print (False)

    Returns:
        Updated config with proper Postgres port
    """
    port = os.environ.get("POSTGRES_PORT") or config["postgres"].get("port")
    try:
        if port is not None:
            config["postgres"]["port"] = int(port)
        else:
            message = "POSTGRES_PORT not set. Using default port 5432."
            if log_with_logger:
                logger.info(message)
            else:
                print(message)
            config["postgres"]["port"] = 5432
    except ValueError:
        message = f"Invalid port number: {port}. Using default port 5432."
        if log_with_logger:
            logger.warning(message)
        else:
            print(message)
        config["postgres"]["port"] = 5432

    return config


def ensure_redis_port(config, log_with_logger=True):
    """
    Ensure the Redis port is an integer in the config if present.

    Args:
        config: Configuration dictionary
        log_with_logger: Whether to use logger (True) or print (False)

    Returns:
        Updated config with proper Redis port
    """
    if "redis" in config and "port" in config["redis"]:
        redis_port = config["redis"].get("port") or os.environ.get("REDIS_PORT") or 6479
        try:
            config["redis"]["port"] = int(redis_port)
        except ValueError:
            message = f"Invalid Redis port number: {redis_port}. Using default port 6479."
            if log_with_logger:
                logger.warning(message)
            else:
                print(message)
            config["redis"]["port"] = 6479

    return config


@lru_cache(maxsize=1)
def load_config(config_path: str = CONFIG_PATH) -> dict[str, Any]:
    """
    Load configuration from a YAML file with caching and environment variable resolution.

    Args:
        config_path: Path to the configuration file

    Returns:
        Dictionary containing the configuration
    """
    try:
        # Check if a config file exists
        if not os.path.exists(config_path):
            logger.error("Configuration file not found at %s", config_path)
            raise FileNotFoundError(f"Configuration file not found at {config_path}")

        # Load configuration from YAML file
        with open(config_path, encoding="utf-8") as f:
            config = yaml.safe_load(f)

        # Resolve environment variables
        config = resolve_nested(config)

        # Ensure ports are integers
        config = ensure_postgres_port(config)
        config = ensure_redis_port(config)

        # Ensure postgres password is set from secrets
        if "postgres" in config and resolved_secrets.get("postgres_password"):
            config["postgres"]["password"] = resolved_secrets["postgres_password"]

        return config
    except Exception as ex:
        logger.error("Error loading configuration: %s", str(ex))
        raise


# Load the config at module import time
resolved_config = load_config()

logger.info("Configuration loaded successfully")


def get_resolved_config():
    """
    Get the resolved configuration that was loaded at module import time.

    Returns:
        dict[str, Any]: The resolved configuration dictionary
    """
    return resolved_config


def get_resolved_secrets():
    """
    Get the resolved secrets that were loaded at module import time.

    Returns:
        dict[str, Any]: The resolved secrets dictionary
    """
    return resolved_secrets


def get_resolved_prompts():
    """
    Get the resolved prompts that were loaded at module import time.

    Returns:
        dict[str, Any]: The resolved prompts dictionary
    """
    return resolved_prompts


def get_new_users_config():
    """
    Get the new users configuration that was loaded at module import time.
    This contains default settings for new user registration.

    Returns:
        dict[str, Any]: The new users configuration dictionary
    """
    return resolved_new_users_config


# Add a function to reload the configuration


def reload_config():
    """
    Force reload of configuration without using cached values.
    This is useful when configuration has been modified at runtime.

    Returns:
        Dictionary containing the reloaded configuration
    """
    global resolved_config
    try:
        # Clear the cache
        load_config.cache_clear()
        # Try to load the config
        new_config = load_and_resolve_config()
        resolved_config = new_config
        return new_config
    except FileNotFoundError:
        logger.warning("Config file not found during reload. Using existing config or defaults.")
        # If config file doesn't exist, maintain the current config or use defaults
        if not resolved_config:
            resolved_config = {
                "llm": {
                    "models": {"provider": "local", "local": {"base_url": "http://localhost:11434"}},
                    "advanced": {
                        "gpu_layers": 20,
                        "context_size": 4096,
                        "batch_size": 512,
                        "use_mlock": True,
                        "use_mmap": True,
                    },
                }
            }
        return resolved_config


def load_yaml_config(file_path):
    with open(file_path, encoding="utf-8") as f:
        return yaml.load(f, Loader=SafeLoader)


def load_and_resolve_config():
    # File now lives at src/main/utils/config/loader.py -> go up 5 dirnames to project root.
    # noinspection PyTypeChecker
    script_dir = str(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))))
    config_path = os.path.join(script_dir, "configs", "config.yaml")
    secrets_path = os.path.join(script_dir, "configs", "secrets.yaml")

    config = load_yaml_config(config_path)

    # Try to load a secret file if it exists
    try:
        file_secrets = {}
        if os.path.exists(secrets_path):
            file_secrets = load_yaml_config(secrets_path) or {}
            logger.info("Loaded secrets from %s", secrets_path)
        else:
            logger.warning("Secrets file not found at %s", secrets_path)
    except Exception as ex:
        logger.error("Error loading secrets file: %s", str(ex))
        file_secrets = {}

    # Load secrets using the extracted function
    secrets = load_secrets(file_secrets)

    # Resolve environment variables in config
    config = resolve_nested(config)

    # Ensure ports are integers
    config = ensure_postgres_port(config, log_with_logger=False)
    config = ensure_redis_port(config, log_with_logger=False)

    return config, secrets


async def get_model_config(provider=None, model_type="chat", model_name=None, user_id=None, db=None, **_kwargs):
    """
    Get standardized model configuration based on a provider and model type.

    DEPRECATED: This function now uses the database-based model provider system.
    Consider using get_model_config_from_db directly for better control.

    Args:
        provider (str, optional): The provider name (e.g., 'vllm', 'openai', 'ollama', 'local').
                                If None, use any available provider.
        model_type (str, optional): The type of model ('chat', 'reasoning', 'embeddings').
                                   Defaults to 'chat'.
        model_name (str, optional): Specific model name.
         If provided, this override provider/type selection.
        user_id (UUID, optional): User ID to fetch user-specific models.
        db (Session, optional): Database session to use.

    Returns:
        dict: A dictionary containing:
            - provider: The resolved provider name
            - model: The resolved model name
            - base_url: The base URL for the provider (if applicable)
    """
    from src.main.utils.llm.model_utils import get_model_config_from_db

    # Use the new database-based approach
    return await get_model_config_from_db(provider=provider, model_type=model_type, model_name=model_name, user_id=user_id, db_session=db)
