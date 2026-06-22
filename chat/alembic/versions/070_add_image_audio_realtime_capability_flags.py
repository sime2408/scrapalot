"""Add image / audio / realtime capability flags to model_provider_models

Revision ID: 070
Revises: 069
Create Date: 2026-05-10 09:58:00.000000

Extends the per-model capability surface beyond the original four flags
(supports_tools, supports_streaming, supports_function_calling, supports_vision)
with four more so the chat layer can route image-generation, audio-input
(speech-to-text), audio-output (TTS) and OpenAI-Realtime style sessions to the
right model on a multi-model provider:

- supports_image_generation: dall-e-*, gpt-image-1, flux-*, stable-diffusion-*
- supports_audio_input:      whisper-*, gpt-4o-audio-* with input modality
- supports_audio_output:     tts-*, gpt-4o-audio-* with output modality
- supports_realtime:         gpt-4o-realtime-* and equivalents

Idempotent NOT NULL DEFAULT FALSE — existing rows pick up the default and the
remote_model_sync auto-classifier flips them to TRUE on the next sync where the
model name matches a known image / audio / realtime family.
"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "070"
down_revision: str | None = "069"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_COLUMNS = (
    "supports_image_generation",
    "supports_audio_input",
    "supports_audio_output",
    "supports_realtime",
)


def upgrade() -> None:
    for col in _NEW_COLUMNS:
        op.add_column(
            "model_provider_models",
            sa.Column(
                col,
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    for col in _NEW_COLUMNS:
        op.drop_column("model_provider_models", col)
