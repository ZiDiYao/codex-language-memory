"""Initial tenant-isolated relational language memory schema."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_remote_storage"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('lm_tenants',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('issuer', sa.Text(), nullable=False),
    sa.Column('subject', sa.Text(), nullable=False),
    sa.Column('settings', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('content_version', sa.Integer(), nullable=False),
    sa.Column('preferences_version', sa.Integer(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('lm_points',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('identity_key', sa.String(length=64), nullable=False),
    sa.Column('kind', sa.String(length=12), nullable=False),
    sa.Column('language', sa.String(length=35), nullable=False),
    sa.Column('title', sa.String(length=350), nullable=False),
    sa.Column('title_key', sa.Text(), nullable=False),
    sa.Column('sense_key', sa.Text(), nullable=False),
    sa.Column('meaning', sa.Text(), nullable=False),
    sa.Column('context', sa.Text(), nullable=True),
    sa.Column('corrected_sentence', sa.Text(), nullable=True),
    sa.Column('explanation', sa.Text(), nullable=True),
    sa.Column('examples', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('additional_senses', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('search_text', sa.Text(), nullable=False),
    sa.Column('scenes_custom', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('encounter_count', sa.Integer(), nullable=False),
    sa.Column('repeat_priority', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('last_reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_review_result', sa.String(length=12), nullable=True),
    sa.CheckConstraint("kind IN ('word','expression','grammar','correction')", name='ck_lm_point_kind'),
    sa.CheckConstraint("status IN ('new','mastered')", name='ck_lm_point_status'),
    sa.ForeignKeyConstraint(['tenant_id'], ['lm_tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('tenant_id', 'id', name='uq_lm_point_tenant_id'),
    sa.UniqueConstraint('tenant_id', 'identity_key', name='uq_lm_point_identity')
    )
    op.create_index('ix_lm_point_tenant_recent', 'lm_points', ['tenant_id', 'last_seen_at', 'id'], unique=False)
    op.create_index('ix_lm_point_tenant_scope', 'lm_points', ['tenant_id', 'language', 'kind'], unique=False)
    op.create_table('lm_review_requests',
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('request_id', sa.String(length=100), nullable=False),
    sa.Column('fingerprint', sa.String(length=64), nullable=False),
    sa.Column('result', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['lm_tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('tenant_id', 'request_id')
    )
    op.create_table('lm_save_requests',
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('request_id', sa.String(length=100), nullable=False),
    sa.Column('fingerprint', sa.String(length=64), nullable=False),
    sa.Column('results', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['lm_tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('tenant_id', 'request_id')
    )
    op.create_table('lm_scenes',
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id'], ['lm_tenants.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('tenant_id', 'key')
    )
    op.create_table('lm_encounters',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('point_id', sa.Integer(), nullable=False),
    sa.Column('request_id', sa.String(length=100), nullable=False),
    sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('context', sa.Text(), nullable=True),
    sa.Column('source', sa.String(length=12), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id', 'point_id'], ['lm_points.tenant_id', 'lm_points.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('tenant_id', 'point_id', 'request_id', name='uq_lm_encounter_request')
    )
    op.create_index('ix_lm_encounter_point', 'lm_encounters', ['tenant_id', 'point_id', 'id'], unique=False)
    op.create_table('lm_memory_states',
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('point_id', sa.Integer(), nullable=False),
    sa.Column('card', sa.Text(), nullable=False),
    sa.Column('due_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('rated_reviews', sa.Integer(), nullable=False),
    sa.Column('algorithm', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id', 'point_id'], ['lm_points.tenant_id', 'lm_points.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('tenant_id', 'point_id')
    )
    op.create_index('ix_lm_memory_due', 'lm_memory_states', ['tenant_id', 'due_at'], unique=False)
    op.create_table('lm_point_scenes',
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('point_id', sa.Integer(), nullable=False),
    sa.Column('scene_key', sa.Text(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['tenant_id', 'point_id'], ['lm_points.tenant_id', 'lm_points.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['tenant_id', 'scene_key'], ['lm_scenes.tenant_id', 'lm_scenes.key'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('tenant_id', 'point_id', 'scene_key')
    )
    op.create_index('ix_lm_point_scene_filter', 'lm_point_scenes', ['tenant_id', 'scene_key', 'point_id'], unique=False)
    op.create_table('lm_review_events',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('tenant_id', sa.String(length=64), nullable=False),
    sa.Column('point_id', sa.Integer(), nullable=False),
    sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('result', sa.String(length=12), nullable=False),
    sa.Column('assisted', sa.Boolean(), nullable=False),
    sa.Column('effort', sa.String(length=12), nullable=False),
    sa.Column('prompt', sa.Text(), nullable=True),
    sa.Column('answer', sa.Text(), nullable=True),
    sa.Column('rating', sa.Integer(), nullable=True),
    sa.Column('predicted_recall', sa.Float(), nullable=True),
    sa.Column('fsrs_log', sa.Text(), nullable=True),
    sa.Column('algorithm', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=True),
    sa.ForeignKeyConstraint(['tenant_id', 'point_id'], ['lm_points.tenant_id', 'lm_points.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_lm_review_point', 'lm_review_events', ['tenant_id', 'point_id', 'id'], unique=False)


def downgrade():
    op.drop_index('ix_lm_review_point', table_name='lm_review_events')
    op.drop_table('lm_review_events')
    op.drop_index('ix_lm_point_scene_filter', table_name='lm_point_scenes')
    op.drop_table('lm_point_scenes')
    op.drop_index('ix_lm_memory_due', table_name='lm_memory_states')
    op.drop_table('lm_memory_states')
    op.drop_index('ix_lm_encounter_point', table_name='lm_encounters')
    op.drop_table('lm_encounters')
    op.drop_table('lm_scenes')
    op.drop_table('lm_save_requests')
    op.drop_table('lm_review_requests')
    op.drop_index('ix_lm_point_tenant_scope', table_name='lm_points')
    op.drop_index('ix_lm_point_tenant_recent', table_name='lm_points')
    op.drop_table('lm_points')
    op.drop_table('lm_tenants')
