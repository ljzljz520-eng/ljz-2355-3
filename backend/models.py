"""PostgreSQL schema: brands, themes, token inheritance, design versions,
component dependencies, screenshots, confirmations and check reports."""
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


class Brand(Base):
    __tablename__ = "brands"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), unique=True, nullable=False)
    slug = Column(String(120), unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)


class Theme(Base):
    """A theme inherits from an optional parent theme (theme inheritance graph)."""
    __tablename__ = "themes"
    id = Column(Integer, primary_key=True)
    brand_id = Column(Integer, ForeignKey("brands.id"), nullable=False)
    name = Column(String(120), nullable=False)
    slug = Column(String(120), unique=True, nullable=False)
    parent_id = Column(Integer, ForeignKey("themes.id"), nullable=True)
    # Tokens directly declared in this theme. References point at another path
    # e.g. {"value": "{color.brand.primary}", "type": "color"}.
    tokens = Column(JSONB, nullable=False, default=dict)
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    updated_at = Column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (UniqueConstraint("brand_id", "name", name="uq_theme_brand_name"),)


class DesignVersion(Base):
    """A frozen design version. The snapshot stores every theme's fully
    resolved expansion so reports/screenshots stay reproducible."""
    __tablename__ = "design_versions"
    id = Column(Integer, primary_key=True)
    version = Column(String(40), unique=True, nullable=False)
    snapshot = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    created_by = Column(String(120), nullable=True)
    note = Column(Text, nullable=True)


class Component(Base):
    __tablename__ = "components"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), unique=True, nullable=False)
    slug = Column(String(120), unique=True, nullable=False)
    kind = Column(String(40), nullable=False, default="component")
    # Token paths the component consumes (contract). If a component does not
    # support a newly introduced token it will be missing from this list.
    supported_tokens = Column(JSONB, nullable=False, default=list)
    # Per-state usage: {state: {foreground, background, font_size_path,
    # icon_color_path, text_used, interactive, note}}
    states = Column(JSONB, nullable=False, default=dict)
    # Tokens that must be overridden in every leaf theme for this component to
    # be correctly themed (used for "theme override gaps").
    required_token_paths = Column(JSONB, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), default=utcnow)


class ComponentDependency(Base):
    """Edge in the component dependency graph: component depends_on another."""
    __tablename__ = "component_dependencies"
    id = Column(Integer, primary_key=True)
    component_id = Column(Integer, ForeignKey("components.id"), nullable=False)
    depends_on_id = Column(Integer, ForeignKey("components.id"), nullable=False)
    version_bound = Column(String(40), nullable=True)

    __table_args__ = (
        UniqueConstraint("component_id", "depends_on_id", name="uq_comp_dep"),
    )


class ComponentVersionSupport(Base):
    """Which design version each component supports. Used to detect old
    components that never adopted a token introduced by a newer version."""
    __tablename__ = "component_version_support"
    id = Column(Integer, primary_key=True)
    component_id = Column(Integer, ForeignKey("components.id"), nullable=False)
    design_version = Column(String(40), nullable=False)
    supports_version = Column(Boolean, nullable=False, default=True)

    __table_args__ = (
        UniqueConstraint("component_id", "design_version", name="uq_comp_ver"),
    )


class ScreenshotTask(Base):
    __tablename__ = "screenshot_tasks"
    id = Column(Integer, primary_key=True)
    component_id = Column(Integer, ForeignKey("components.id"), nullable=False)
    theme_slug = Column(String(120), nullable=False)
    state = Column(String(40), nullable=False)  # default/hover/error/disabled...
    status = Column(String(20), nullable=False, default="pending")
    # pending -> running -> completed | interrupted | failed
    fail_step = Column(String(120), nullable=True)
    error = Column(Text, nullable=True)
    artifact_path = Column(String(500), nullable=True)
    token_version_hash = Column(String(80), nullable=True)
    design_version = Column(String(40), nullable=True)
    attempted_at = Column(DateTime(timezone=True), default=utcnow)
    completed_at = Column(DateTime(timezone=True), nullable=True)


class Confirmation(Base):
    """Designer confirmation tied to a concrete screenshot + token version."""
    __tablename__ = "confirmations"
    id = Column(Integer, primary_key=True)
    component_id = Column(Integer, ForeignKey("components.id"), nullable=False)
    theme_slug = Column(String(120), nullable=False)
    state = Column(String(40), nullable=False)
    designer = Column(String(120), nullable=False)
    status = Column(String(20), nullable=False, default="confirmed")
    # confirmed | needs_rereview | superseded
    confirmed_token_hash = Column(String(80), nullable=False)
    current_token_hash = Column(String(80), nullable=True)
    screenshot_id = Column(Integer, ForeignKey("screenshot_tasks.id"), nullable=True)
    note = Column(Text, nullable=True)
    confirmed_at = Column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        UniqueConstraint("component_id", "theme_slug", "state", "designer",
                         name="uq_confirmation"),
    )


class CheckReport(Base):
    __tablename__ = "check_reports"
    id = Column(Integer, primary_key=True)
    design_version = Column(String(40), nullable=False)
    status = Column(String(20), nullable=False, default="pending")
    # pending -> running -> completed | failed
    findings = Column(JSONB, nullable=False, default=list)
    summary = Column(JSONB, nullable=False, default=dict)
    generated_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id = Column(Integer, primary_key=True)
    kind = Column(String(60), nullable=False)
    payload = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=utcnow)
