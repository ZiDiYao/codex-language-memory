"""Tenant-scoped PostgreSQL repository for the remote MCP and HTTP surfaces.

Every operation obtains its tenant from the verified issuer/subject principal.
Writes lock that tenant's row, making receipts and their effects atomic even
across different API workers. SQLite is used only by isolated tests.
"""

import base64
import copy
import hashlib
import json
from contextlib import contextmanager
from datetime import datetime, timezone

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import and_, case, delete as sql_delete, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from cloud.models import (Encounter, MemoryState, Point, PointScene, ReviewEvent,
                          ReviewRequest, SaveRequest, Scene, Tenant)
from learning import ALGORITHM, advance, memory_snapshot, recall_rating
from scenes import infer_scenes, unique_scenes
from store import (CaptureMode, KnowledgePoint, LearningSettings, Limit, Patch,
                   RequestId, Review, SettingsPatch, encode, normalized, record)
from word_records import merge_sense


def instant():
    return datetime.now(timezone.utc)


def aware(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def stamp(value):
    return aware(value).isoformat(timespec="microseconds") if value else None


def fingerprint(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def validate_database_text(value):
    """PostgreSQL UTF-8 text/JSONB cannot store NUL or lone surrogates."""
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("Text must contain valid Unicode characters") from None
        if "\x00" in value:
            raise ValueError("Text cannot contain a NUL character")
    elif isinstance(value, dict):
        for key, item in value.items():
            validate_database_text(key)
            validate_database_text(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            validate_database_text(item)


def tenant_identity(principal):
    issuer = principal.get("issuer") if isinstance(principal, dict) else getattr(principal, "issuer", None)
    subject = principal.get("subject") if isinstance(principal, dict) else getattr(principal, "subject", None)
    if not isinstance(issuer, str) or not issuer or not isinstance(subject, str) or not subject:
        raise ValueError("A verified issuer and subject are required")
    validate_database_text([issuer, subject])
    # Structured encoding avoids ambiguous delimiter collisions in opaque subjects.
    return fingerprint([issuer, subject]), issuer, subject


class Repository:
    def __init__(self, session_factory, principal):
        self.session_factory = session_factory
        self.tenant_id, self.issuer, self.subject = tenant_identity(principal)

    @contextmanager
    def _transaction(self, *, write=False):
        with self.session_factory() as session, session.begin():
            dialect = session.get_bind().dialect.name
            if dialect == "sqlite" and write:
                session.connection().exec_driver_sql("BEGIN IMMEDIATE")
            tenant = session.get(Tenant, self.tenant_id)
            if tenant is None:
                insert = pg_insert if dialect == "postgresql" else sqlite_insert
                session.execute(insert(Tenant).values(
                    id=self.tenant_id, issuer=self.issuer, subject=self.subject,
                    settings={}, content_version=0, preferences_version=0,
                ).on_conflict_do_nothing(index_elements=["id"]))
                tenant = session.get(Tenant, self.tenant_id)
            if write and dialect == "postgresql":
                tenant = session.scalar(select(Tenant).where(Tenant.id == self.tenant_id)
                                        .with_for_update().execution_options(populate_existing=True))
            yield session, tenant

    def ping(self):
        with self.session_factory() as session:
            session.execute(select(1)).scalar_one()
        return {"status": "ok"}

    @staticmethod
    def _settings(tenant):
        return LearningSettings.model_validate(tenant.settings).model_dump()

    def settings(self, patch=None):
        if patch is not None and not isinstance(patch, SettingsPatch):
            patch = SettingsPatch.model_validate(patch)
        with self._transaction(write=patch is not None) as (_, tenant):
            current = self._settings(tenant)
            if patch is not None:
                current.update(patch.model_dump(exclude_unset=True))
                current = LearningSettings.model_validate(current).model_dump()
                tenant.settings = current
                tenant.preferences_version += 1
            return current

    def versions(self):
        with self._transaction() as (_, tenant):
            return {"content": tenant.content_version, "preferences": tenant.preferences_version}

    def recording(self, enabled=None):
        result = self.settings(SettingsPatch(enabled=enabled) if enabled is not None else None)
        return {"enabled": result["enabled"]}

    def _point(self, session, identifier):
        return session.scalar(select(Point).where(Point.tenant_id == self.tenant_id, Point.id == identifier))

    def _labels(self, session, identifier):
        return list(session.scalars(select(Scene.name).join(PointScene, and_(
            PointScene.tenant_id == Scene.tenant_id, PointScene.scene_key == Scene.key,
        )).where(Scene.tenant_id == self.tenant_id, PointScene.tenant_id == self.tenant_id,
                 PointScene.point_id == identifier).order_by(PointScene.position, Scene.key)))

    def _set_scenes(self, session, point, labels):
        labels = unique_scenes(labels)
        session.execute(sql_delete(PointScene).where(
            PointScene.tenant_id == self.tenant_id, PointScene.point_id == point.id))
        for position, name in enumerate(labels):
            key = normalized(name)
            scene = session.get(Scene, (self.tenant_id, key))
            if scene is None:
                session.add(Scene(tenant_id=self.tenant_id, key=key, name=name))
                session.flush()
            session.add(PointScene(tenant_id=self.tenant_id, point_id=point.id,
                                   scene_key=key, position=position))
        session.flush()

    @staticmethod
    def _identity(kind, language, title, sense_key):
        return fingerprint([kind, language, normalized(title), "" if kind == "word" else normalized(sense_key)])

    def _record(self, session, point):
        keys = ("id", "kind", "language", "title", "title_key", "sense_key", "meaning",
                "context", "corrected_sentence", "explanation", "note", "status",
                "encounter_count", "repeat_priority", "last_review_result")
        result = {key: getattr(point, key) for key in keys}
        result.update(examples=encode(point.examples), additional_senses=encode(point.additional_senses),
                      scenes=encode(self._labels(session, point.id)))
        for key in ("created_at", "last_seen_at", "last_reviewed_at"):
            result[key] = stamp(getattr(point, key))
        return record(result)

    @staticmethod
    def _search_text(point):
        values = [getattr(point, key) or "" for key in (
            "title", "sense_key", "meaning", "context", "corrected_sentence", "explanation", "note")]
        return normalized("\n".join(values + [encode(point.examples), encode(point.additional_senses)]))

    def save(self, request_id, items, source="automatic"):
        TypeAdapter(RequestId).validate_python(request_id, strict=True)
        TypeAdapter(CaptureMode).validate_python(source, strict=True)
        if not isinstance(items, list) or not 1 <= len(items) <= 20:
            raise ValueError("Supply between 1 and 20 knowledge points")
        # ASCII JSON can fingerprint even a rejected lone-surrogate item, letting
        # the rest of a partial batch commit and its rejection replay safely.
        payload = items if source == "automatic" else {"source": source, "items": items}
        digest = hashlib.sha256(json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self._transaction(write=True) as (session, tenant):
            receipt = session.get(SaveRequest, (self.tenant_id, request_id))
            if receipt:
                if receipt.fingerprint != digest:
                    return {"status": "failed", "error": "request_id_conflict"}
                results = copy.deepcopy(receipt.results)
                for result in results:
                    if "id" in result and self._point(session, result["id"]) is None:
                        result["deleted"] = True
                return {"status": "processed", "replayed": True, "results": results}
            settings = self._settings(tenant)
            if not settings["enabled"]:
                return {"status": "paused", "results": []}
            timestamp, seen, results = instant(), set(), []
            for index, item in enumerate(items):
                try:
                    validate_database_text(item)
                    incoming = KnowledgePoint.model_validate(item)
                except ValidationError as error:
                    results.append({"index": index, "status": "failed", "errors": [
                        {"field": ".".join(map(str, detail["loc"])), "message": detail["msg"]}
                        for detail in error.errors()]})
                    continue
                except ValueError as error:
                    results.append({"index": index, "status": "failed", "errors": [
                        {"field": "content", "message": str(error)}]})
                    continue
                if incoming.kind not in settings["enabled_types"]:
                    results.append({"index": index, "status": "skipped", "reason": "type_disabled"})
                    continue
                encounter_key = (incoming.kind, incoming.language, normalized(incoming.title), normalized(incoming.sense_key))
                if encounter_key in seen:
                    results.append({"index": index, "status": "failed", "error": "duplicate_in_batch"})
                    continue
                seen.add(encounter_key)
                key = self._identity(incoming.kind, incoming.language, incoming.title, incoming.sense_key)
                point = session.scalar(select(Point).where(Point.tenant_id == self.tenant_id, Point.identity_key == key))
                if point is None:
                    values = incoming.model_dump(exclude={"scenes", "sense_key"})
                    values["examples"] = [example.model_dump(exclude_none=True) for example in incoming.examples]
                    point = Point(**values, tenant_id=self.tenant_id, identity_key=key,
                                  title_key=normalized(incoming.title), sense_key=normalized(incoming.sense_key),
                                  created_at=timestamp, last_seen_at=timestamp, encounter_count=1,
                                  repeat_priority=0, status="new", additional_senses=[], scenes_custom=False)
                    # sense_key is normalized separately from the input content.
                    session.add(point)
                    session.flush()
                    labels = incoming.scenes if incoming.scenes is not None else infer_scenes(incoming.model_dump())
                    self._set_scenes(session, point, labels)
                    action = "added"
                else:
                    labels = self._labels(session, point.id)
                    merged_labels = (unique_scenes([*labels, *incoming.scenes])
                                     if incoming.scenes is not None and not point.scenes_custom else labels)
                    if len(merged_labels) > 12:
                        results.append({"index": index, "status": "failed", "error": "scene_limit_exceeded"})
                        continue
                    previous = session.scalar(select(Encounter).where(
                        Encounter.tenant_id == self.tenant_id, Encounter.point_id == point.id,
                        Encounter.request_id == request_id))
                    same_sense = normalized(incoming.sense_key) == point.sense_key
                    if incoming.kind == "word":
                        current = self._record(session, point)
                        point.additional_senses = merge_sense(current, incoming.model_dump())
                    if not previous:
                        point.encounter_count += 1
                        point.repeat_priority += 1
                    point.last_seen_at = timestamp
                    if same_sense:
                        if incoming.context is not None:
                            point.context = incoming.context
                        point.explanation = point.explanation or incoming.explanation
                        point.corrected_sentence = point.corrected_sentence or incoming.corrected_sentence
                        if point.note is None and len({normalized(e["text"]) for e in point.examples}) < 2:
                            originals = {normalized(e["text"]) for e in point.examples}
                            point.examples = [*point.examples, *[
                                e.model_dump(exclude_none=True) for e in incoming.examples
                                if normalized(e.text) not in originals]][:5]
                    if merged_labels != labels:
                        self._set_scenes(session, point, merged_labels)
                    action = "merged"
                point.search_text = self._search_text(point)
                entry = session.scalar(select(Encounter).where(
                    Encounter.tenant_id == self.tenant_id, Encounter.point_id == point.id,
                    Encounter.request_id == request_id))
                if entry:
                    entry.context = "\n\n".join(dict.fromkeys(filter(None, (entry.context, incoming.context)))) or None
                else:
                    session.add(Encounter(tenant_id=self.tenant_id, point_id=point.id,
                                          request_id=request_id, occurred_at=timestamp,
                                          context=incoming.context, source=source))
                session.flush()
                tenant.content_version += 1
                results.append({"index": index, "status": action, "id": point.id, "encounter_count": point.encounter_count})
            session.add(SaveRequest(tenant_id=self.tenant_id, request_id=request_id, fingerprint=digest, results=results))
            return {"status": "processed", "replayed": False, "results": results}

    def _filters(self, *, keyword=None, kind=None, language=None, status=None, scene=None, include_variants=False):
        validate_database_text([keyword, kind, language, status, scene])
        filters = [Point.tenant_id == self.tenant_id]
        for column, value in ((Point.kind, kind), (Point.status, status)):
            if value is not None:
                filters.append(column == value)
        if language is not None:
            language = language.lower()
            filters.append(or_(Point.language == language, Point.language.startswith(language + "-", autoescape=True))
                           if include_variants else Point.language == language)
        if keyword is not None:
            filters.append(Point.search_text.contains(normalized(keyword), autoescape=True))
        if scene is not None:
            filters.append(exists(select(1).where(
                PointScene.tenant_id == self.tenant_id, PointScene.point_id == Point.id,
                PointScene.scene_key == normalized(scene))))
        return filters

    def query(self, *, keyword=None, kind=None, language=None, status=None, scene=None,
              limit=10, offset=0, include_variants=False, cursor=None, needs_enrichment=False):
        TypeAdapter(Limit).validate_python(limit, strict=True)
        if type(offset) is not int or offset < 0:
            raise ValueError("Invalid query offset")
        filters = self._filters(keyword=keyword, kind=kind, language=language, status=status, scene=scene,
                                include_variants=include_variants)
        term = normalized(keyword or "")
        rank = case((Point.title_key == term, 0), (Point.title_key.startswith(term, autoescape=True), 1),
                    (Point.title_key.contains(term, autoescape=True), 2), else_=3) if term else 0
        scope = fingerprint([self.tenant_id, term, kind, language, status, scene, include_variants, needs_enrichment])
        rank_column = rank if term else case((Point.id > 0, 0), else_=0)
        if cursor is not None:
            try:
                position = json.loads(base64.urlsafe_b64decode(cursor).decode())
                cursor_rank, timestamp, identifier, cursor_scope = position
                timestamp = datetime.fromisoformat(timestamp)
                if (cursor_scope != scope or type(identifier) is not int or identifier < 1 or offset
                        or type(cursor_rank) is not int or cursor_rank not in range(4)):
                    raise ValueError()
            except (ValueError, TypeError, UnicodeError):
                raise ValueError("Invalid query cursor") from None
            filters.append(or_(rank_column > cursor_rank, and_(rank_column == cursor_rank, or_(
                Point.last_seen_at < timestamp, and_(Point.last_seen_at == timestamp, Point.id < identifier)))))
        with self._transaction() as (session, _):
            statement = select(Point, rank_column.label("search_rank")).where(*filters).order_by(
                rank_column, Point.last_seen_at.desc(), Point.id.desc())
            if needs_enrichment:
                rows = [(point, score) for point, score in session.execute(statement)
                        if point.note is None and (not point.explanation or len({normalized(e["text"]) for e in point.examples}) < 2)]
                rows = rows[offset:offset + limit + 1]
            else:
                rows = session.execute(statement.limit(limit + 1).offset(offset)).all()
            records = [self._record(session, point) for point, _ in rows[:limit]]
        more = len(rows) > limit
        next_cursor = None
        if more:
            point, score = rows[limit - 1]
            next_cursor = base64.urlsafe_b64encode(encode([score, stamp(point.last_seen_at), point.id, scope]).encode()).decode()
        return {"records": records, "has_more": more, "next_cursor": next_cursor}

    def get_point(self, record_id):
        with self._transaction() as (session, _):
            point = self._point(session, record_id)
            return {"status": "found", "record": self._record(session, point)} if point else {"status": "not_found"}

    def update(self, record_id, patch, expected_revision=None):
        if not isinstance(patch, Patch):
            patch = Patch.model_validate(patch)
        changes = patch.model_dump(exclude_unset=True)
        validate_database_text(changes)
        if not changes:
            return {"status": "failed", "error": "empty_patch"}
        for required in ("title", "sense_key", "meaning", "status", "review_result", "scenes"):
            if required in changes and changes[required] is None:
                return {"status": "failed", "error": f"{required}_cannot_be_null"}
        if "review_result" in changes:
            return {"status": "failed", "error": "use_record_review_with_request_id"}
        with self._transaction(write=True) as (session, tenant):
            point = self._point(session, record_id)
            if point is None:
                return {"status": "not_found"}
            current = self._record(session, point)
            if expected_revision is not None and current["revision"] != expected_revision:
                return {"status": "failed", "error": "edit_conflict", "record": current}
            identity = self._identity(point.kind, point.language, changes.get("title", point.title), changes.get("sense_key", point.sense_key))
            conflict = session.scalar(select(Point.id).where(
                Point.tenant_id == self.tenant_id, Point.identity_key == identity, Point.id != point.id))
            if conflict is not None:
                return {"status": "failed", "error": "identity_conflict"}
            labels = changes.pop("scenes", None)
            for key, value in changes.items():
                if key == "examples" and value is None:
                    value = []
                setattr(point, key, normalized(value) if key == "sense_key" else value)
            point.title_key, point.identity_key = normalized(point.title), identity
            if labels is not None:
                self._set_scenes(session, point, labels)
                point.scenes_custom = True
            point.search_text = self._search_text(point)
            tenant.content_version += 1
            session.flush()
            return {"status": "updated", "record": self._record(session, point)}

    def delete(self, record_id):
        with self._transaction(write=True) as (session, tenant):
            point = self._point(session, record_id)
            if point is None:
                return {"status": "not_found", "id": record_id}
            session.delete(point)
            tenant.content_version += 1
            return {"status": "deleted", "id": record_id}

    def scenes(self, *, language=None, kind=None, include_variants=False):
        filters = self._filters(language=language, kind=kind, include_variants=include_variants)
        with self._transaction() as (session, _):
            rows = session.execute(select(Scene.name, func.count(PointScene.point_id)).join(
                PointScene, and_(Scene.tenant_id == PointScene.tenant_id, Scene.key == PointScene.scene_key)
            ).join(Point, and_(Point.tenant_id == PointScene.tenant_id, Point.id == PointScene.point_id))
                .where(Scene.tenant_id == self.tenant_id, PointScene.tenant_id == self.tenant_id, *filters)
                .group_by(Scene.key, Scene.name).order_by(Scene.key)).all()
            total = session.scalar(select(func.count(func.distinct(Point.id))).join(
                PointScene, and_(Point.tenant_id == PointScene.tenant_id, Point.id == PointScene.point_id)
            ).where(PointScene.tenant_id == self.tenant_id, *filters))
            return {"scenes": [{"name": name, "count": count} for name, count in rows], "total": total}

    def languages(self):
        with self._transaction() as (session, _):
            rows = session.execute(select(Point.language, Point.kind, func.count()).where(
                Point.tenant_id == self.tenant_id).group_by(Point.language, Point.kind)).all()
        codes, counts, kinds, by_language = set(), {}, {}, {}
        for language, kind, total in rows:
            base = language.split("-")[0]
            codes.update((language, base))
            counts[base] = counts.get(base, 0) + total
            kinds[kind] = kinds.get(kind, 0) + total
            group = by_language.setdefault(base, {})
            group[kind] = group.get(kind, 0) + total
        return {"languages": sorted(codes), "counts": counts, "kinds": kinds, "by_language": by_language}

    def record_review(self, record_id, request_id, review):
        TypeAdapter(RequestId).validate_python(request_id, strict=True)
        if not isinstance(review, Review):
            review = Review.model_validate(review)
        validate_database_text(review.model_dump())
        digest = fingerprint([record_id, review.model_dump()])
        with self._transaction(write=True) as (session, tenant):
            receipt = session.get(ReviewRequest, (self.tenant_id, request_id))
            if receipt:
                if receipt.fingerprint != digest:
                    return {"status": "failed", "error": "request_id_conflict"}
                result = copy.deepcopy(receipt.result)
                if self._point(session, record_id) is None:
                    result["deleted"] = True
                return {**result, "replayed": True}
            point = self._point(session, record_id)
            if point is None:
                return {"status": "not_found"}
            timestamp = instant()
            state = session.get(MemoryState, (self.tenant_id, record_id))
            serialized, rated_reviews = (state.card, state.rated_reviews) if state else (None, 0)
            rating = recall_rating(review.result, review.assisted, review.effort)
            prediction = log = None
            if rating is not None:
                try:
                    card, log, prediction = advance(record_id, serialized, rating, stamp(timestamp))
                except ValueError as error:
                    return {"status": "failed", "error": str(error)}
                serialized, rated_reviews = card.to_json(), rated_reviews + 1
                if state is None:
                    state = MemoryState(tenant_id=self.tenant_id, point_id=record_id)
                    session.add(state)
                state.card, state.due_at = serialized, card.due
                state.rated_reviews, state.algorithm = rated_reviews, ALGORITHM
            event = ReviewEvent(tenant_id=self.tenant_id, point_id=record_id, occurred_at=timestamp,
                                result=review.result, assisted=review.assisted, effort=review.effort,
                                prompt=review.prompt, answer=review.answer, rating=int(rating) if rating else None,
                                predicted_recall=prediction, fsrs_log=log.to_json() if log else None,
                                algorithm=ALGORITHM if log else None)
            session.add(event)
            point.last_reviewed_at, point.last_review_result = timestamp, review.result
            if review.result == "correct" and not review.assisted:
                point.repeat_priority = 0
            tenant.content_version += 1
            session.flush()
            result = {"status": "reviewed", "record_id": record_id, "event_id": event.id,
                      "scheduled": rating is not None, "rating": int(rating) if rating else None,
                      "memory": memory_snapshot(serialized, stamp(timestamp), rated_reviews)}
            session.add(ReviewRequest(tenant_id=self.tenant_id, request_id=request_id,
                                      fingerprint=digest, result=result))
            return {**result, "replayed": False}

    def review(self, *, language=None, kind=None, scene=None, limit=5, include_variants=False,
               include_upcoming=False, exclude_ids=None):
        TypeAdapter(Limit).validate_python(limit, strict=True)
        timestamp = instant()
        filters = self._filters(language=language, kind=kind, scene=scene,
                                status="new", include_variants=include_variants)
        if exclude_ids:
            filters.append(Point.id.not_in(exclude_ids))
        with self._transaction() as (session, _):
            rows = session.execute(select(Point, MemoryState).outerjoin(MemoryState, and_(
                MemoryState.tenant_id == self.tenant_id, MemoryState.point_id == Point.id
            )).where(*filters)).all()
            rows = [(p, s) for p, s in rows if p.note is None or normalized(p.note)]
            due = [(p, s) for p, s in rows if s and aware(s.due_at) <= timestamp]
            upcoming = [(p, s) for p, s in rows if s and aware(s.due_at) > timestamp]
            counts = {"eligible": len(rows), "due": len(due),
                      "unassessed": sum(s is None for _, s in rows), "upcoming": len(upcoming)}
            def sort_key(pair):
                point, state = pair
                reason = 0 if point.repeat_priority else 1 if state and aware(state.due_at) <= timestamp else 2 if not state else 3
                return reason, -point.repeat_priority, stamp(state.due_at) if state else "", stamp(point.created_at), point.id
            eligible = [(p, s) for p, s in rows if include_upcoming or p.repeat_priority or not s or aware(s.due_at) <= timestamp]
            records = []
            for point, state in sorted(eligible, key=sort_key)[:limit]:
                item = self._record(session, point)
                item["memory"] = memory_snapshot(state.card if state else None, stamp(timestamp), state.rated_reviews if state else 0)
                item["review_reason"] = ("repeated_question" if point.repeat_priority else "unassessed" if not state else
                                         "due" if aware(state.due_at) <= timestamp else "upcoming")
                latest = session.scalar(select(ReviewEvent).where(
                    ReviewEvent.tenant_id == self.tenant_id, ReviewEvent.point_id == point.id
                ).order_by(ReviewEvent.id.desc()).limit(1))
                item["last_attempt"] = ({"occurred_at": stamp(latest.occurred_at), "result": latest.result,
                                          "assisted": latest.assisted, "prompt": latest.prompt, "answer": latest.answer}
                                         if latest else None)
                records.append(item)
            return {"records": records, "counts": counts, "next_due_at": min((stamp(s.due_at) for _, s in upcoming), default=None),
                    "as_of": stamp(timestamp), "algorithm": ALGORITHM}
