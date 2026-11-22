"""Relational multi-tenant schema; foreign keys include the tenant boundary."""

from sqlalchemy import (JSON, Boolean, CheckConstraint, DateTime, Float,
                        ForeignKey, ForeignKeyConstraint, Index, Integer,
                        String, Text, UniqueConstraint)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


JSON_DATA = JSON().with_variant(JSONB(), "postgresql")


class Tenant(Base):
    __tablename__ = "lm_tenants"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    issuer: Mapped[str] = mapped_column(Text)
    subject: Mapped[str] = mapped_column(Text)
    settings: Mapped[dict] = mapped_column(JSON_DATA, default=dict)
    content_version: Mapped[int] = mapped_column(Integer, default=0)
    preferences_version: Mapped[int] = mapped_column(Integer, default=0)


class Point(Base):
    __tablename__ = "lm_points"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("lm_tenants.id", ondelete="CASCADE"), nullable=False)
    identity_key: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(12))
    language: Mapped[str] = mapped_column(String(35))
    title: Mapped[str] = mapped_column(String(350))
    title_key: Mapped[str] = mapped_column(Text)
    sense_key: Mapped[str] = mapped_column(Text)
    meaning: Mapped[str] = mapped_column(Text)
    context: Mapped[str | None] = mapped_column(Text)
    corrected_sentence: Mapped[str | None] = mapped_column(Text)
    explanation: Mapped[str | None] = mapped_column(Text)
    examples: Mapped[list] = mapped_column(JSON_DATA, default=list)
    additional_senses: Mapped[list] = mapped_column(JSON_DATA, default=list)
    note: Mapped[str | None] = mapped_column(Text)
    search_text: Mapped[str] = mapped_column(Text, default="")
    scenes_custom: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[object] = mapped_column(DateTime(timezone=True))
    encounter_count: Mapped[int] = mapped_column(Integer, default=1)
    repeat_priority: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(12), default="new")
    last_reviewed_at: Mapped[object | None] = mapped_column(DateTime(timezone=True))
    last_review_result: Mapped[str | None] = mapped_column(String(12))
    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_lm_point_tenant_id"),
        UniqueConstraint("tenant_id", "identity_key", name="uq_lm_point_identity"),
        CheckConstraint("kind IN ('word','expression','grammar','correction')", name="ck_lm_point_kind"),
        CheckConstraint("status IN ('new','mastered')", name="ck_lm_point_status"),
        Index("ix_lm_point_tenant_recent", "tenant_id", "last_seen_at", "id"),
        Index("ix_lm_point_tenant_scope", "tenant_id", "language", "kind"),
    )


class Scene(Base):
    __tablename__ = "lm_scenes"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("lm_tenants.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))


class PointScene(Base):
    __tablename__ = "lm_point_scenes"
    tenant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    point_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scene_key: Mapped[str] = mapped_column(Text, primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "point_id"], ["lm_points.tenant_id", "lm_points.id"], ondelete="CASCADE"),
        ForeignKeyConstraint(["tenant_id", "scene_key"], ["lm_scenes.tenant_id", "lm_scenes.key"], ondelete="CASCADE"),
        Index("ix_lm_point_scene_filter", "tenant_id", "scene_key", "point_id"),
    )


class SaveRequest(Base):
    __tablename__ = "lm_save_requests"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("lm_tenants.id", ondelete="CASCADE"), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    results: Mapped[list] = mapped_column(JSON_DATA)


class Encounter(Base):
    __tablename__ = "lm_encounters"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64))
    point_id: Mapped[int] = mapped_column(Integer)
    request_id: Mapped[str] = mapped_column(String(100))
    occurred_at: Mapped[object] = mapped_column(DateTime(timezone=True))
    context: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(12))
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "point_id"], ["lm_points.tenant_id", "lm_points.id"], ondelete="CASCADE"),
        UniqueConstraint("tenant_id", "point_id", "request_id", name="uq_lm_encounter_request"),
        Index("ix_lm_encounter_point", "tenant_id", "point_id", "id"),
    )


class MemoryState(Base):
    __tablename__ = "lm_memory_states"
    tenant_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    point_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    card: Mapped[str] = mapped_column(Text)
    due_at: Mapped[object] = mapped_column(DateTime(timezone=True))
    rated_reviews: Mapped[int] = mapped_column(Integer, default=0)
    algorithm: Mapped[dict] = mapped_column(JSON_DATA)
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "point_id"], ["lm_points.tenant_id", "lm_points.id"], ondelete="CASCADE"),
        Index("ix_lm_memory_due", "tenant_id", "due_at"),
    )


class ReviewEvent(Base):
    __tablename__ = "lm_review_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64))
    point_id: Mapped[int] = mapped_column(Integer)
    occurred_at: Mapped[object] = mapped_column(DateTime(timezone=True))
    result: Mapped[str] = mapped_column(String(12))
    assisted: Mapped[bool] = mapped_column(Boolean)
    effort: Mapped[str] = mapped_column(String(12))
    prompt: Mapped[str | None] = mapped_column(Text)
    answer: Mapped[str | None] = mapped_column(Text)
    rating: Mapped[int | None] = mapped_column(Integer)
    predicted_recall: Mapped[float | None] = mapped_column(Float)
    fsrs_log: Mapped[str | None] = mapped_column(Text)
    algorithm: Mapped[dict | None] = mapped_column(JSON_DATA)
    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "point_id"], ["lm_points.tenant_id", "lm_points.id"], ondelete="CASCADE"),
        Index("ix_lm_review_point", "tenant_id", "point_id", "id"),
    )


class ReviewRequest(Base):
    __tablename__ = "lm_review_requests"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("lm_tenants.id", ondelete="CASCADE"), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON_DATA)
