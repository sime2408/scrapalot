from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class UserRole(str, Enum):
    ADMIN = "ADMIN"
    USER = "USER"


class UserBase(BaseModel):
    username: str
    email: str
    first_name: str | None = None
    last_name: str | None = None
    is_active: bool = True


class UserCreate(UserBase):
    password: str


class UserRegister(BaseModel):
    username: str
    email: str
    password: str
    first_name: str | None = None
    last_name: str | None = None
    license_agreement_consent: bool
    content_sharing_consent: bool = True


class UserUpdate(BaseModel):
    username: str | None = None
    email: str | None = None
    password: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    is_active: bool | None = None
    role: UserRole | None = None


class User(BaseModel):
    id: str
    username: str
    email: str
    first_name: str | None = None
    last_name: str | None = None
    profile_picture: str | None = None
    is_active: bool
    role: UserRole
    created_at: datetime
    updated_at: datetime | None = None
    plan: str | None = None
    can_share_workspaces: bool | None = None
    has_password: bool | None = None  # Indicates if user has a password (false for OAuth users)
    license_agreement_consent: bool | None = None  # Whether user has accepted license agreement
    content_sharing_consent: bool | None = None  # Whether user has consented to content sharing
    tour_completed: bool | None = None  # Whether user has completed onboarding tour
    # noinspection PyUnusedName
    model_config = {"from_attributes": True}


class UserProfileUpdate(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None


class PasswordChange(BaseModel):
    current_password: str | None = None  # Optional for OAuth users setting password for the first time
    new_password: str


class Token(BaseModel):
    access_token: str
    token_type: str
