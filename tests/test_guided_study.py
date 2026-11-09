import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from store import Patch, Review, Store
from test_memory import APPROACH
from test_learning import START


class GuidedStudyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / 'study.sqlite3')
        points = [dict(APPROACH, title=title, kind=kind, language=language) for title, kind, language in (
            ('approach', 'word', 'en'), ('on the fence', 'expression', 'en'),
            ('despite vs although', 'grammar', 'en'), ('future point', 'word', 'en'),
            ('empty point', 'word', 'en'), ('mastered point', 'word', 'en'),
            ('Japanese point', 'expression', 'ja'), ('regional point', 'word', 'en-us'),
        )]
        with patch('store.now', return_value=START.isoformat(timespec='microseconds')):
            self.ids = [x['id'] for x in self.store.save('study-fixture', points)['results']]
            self.store.record_review(self.ids[0], 'due-attempt', Review(result='incorrect', prompt='Recall the meaning', answer='Near'))
            self.store.record_review(self.ids[2], 'hint-attempt', Review(result='correct', assisted=True, prompt='Choose a connector', answer='although'))
        with patch('store.now', return_value=(START + timedelta(days=1)).isoformat(timespec='microseconds')):
            self.store.record_review(self.ids[3], 'future-attempt', Review(result='correct'))
        self.store.update(self.ids[4], Patch(note=' \n\t\u3000'))
        self.store.update(self.ids[5], Patch(status='mastered'))
        self.instant = START + timedelta(hours=1)

    def queue(self, **kwargs):
        with patch('store.now', return_value=self.instant.isoformat(timespec='microseconds')):
            return self.store.review(language='en', **kwargs)

    def test_scope_counts_precede_limit_and_order_matches_fsrs(self):
        queue = self.queue(limit=2)
        self.assertEqual([p['id'] for p in queue['records']], self.ids[:2])
        self.assertEqual(queue['counts'], {'eligible': 4, 'due': 1, 'unassessed': 2, 'upcoming': 1})
        self.assertEqual([p['review_reason'] for p in queue['records']], ['due', 'unassessed'])
        self.assertGreater(queue['next_due_at'], queue['as_of'])
        self.assertEqual(queue['records'][0]['last_attempt']['answer'], 'Near')
        self.assertIsNone(queue['records'][1]['last_attempt'])
        self.assertEqual(len(self.queue(include_variants=True)['records']), 4)
        self.assertEqual(self.queue(kind='grammar')['counts']['eligible'], 1)

    def test_round_exclusions_prevent_assisted_and_skipped_loops_without_writes(self):
        before = self.store.history(self.ids[2])
        assisted = self.queue()['records'][2]
        self.assertTrue(assisted['last_attempt']['assisted'])
        self.assertFalse(assisted['memory']['assessed'])
        queue = self.queue(exclude_ids=self.ids[:3])
        self.assertEqual(queue['records'], [])
        self.assertEqual(queue['counts'], {'eligible': 1, 'due': 0, 'unassessed': 0, 'upcoming': 1})
        self.assertEqual(self.store.history(self.ids[2])['reviews'], before['reviews'])
        early = self.queue(exclude_ids=self.ids[:3], include_upcoming=True)
        self.assertEqual([p['id'] for p in early['records']], [self.ids[3]])
        self.assertEqual(early['records'][0]['review_reason'], 'upcoming')
        self.store.record_review(self.ids[1], 'skip-attempt', Review(result='skipped'))
        skipped = self.queue()['records'][1]
        self.assertEqual(skipped['last_attempt']['result'], 'skipped')
        self.assertNotIn(self.ids[1], [p['id'] for p in self.queue(exclude_ids=[self.ids[1]])['records']])

    def test_current_notes_and_mastery_control_eligibility_including_next_due(self):
        self.store.update(self.ids[0], Patch(note='My approach note\nOnly my current wording.'))
        point = self.queue()['records'][0]
        self.assertEqual(point['note'], 'My approach note\nOnly my current wording.')
        self.assertTrue(point['note_is_custom'])
        self.assertEqual(point['last_attempt']['answer'], 'Near')
        self.store.update(self.ids[0], Patch(note=''))
        self.store.update(self.ids[3], Patch(note='\n'))
        queue = self.queue(include_upcoming=True)
        self.assertEqual([p['id'] for p in queue['records']], self.ids[1:3])
        self.assertIsNone(queue['next_due_at'])
        for identifier in self.ids[1:3]:
            self.store.delete(identifier)
        queue = self.queue()
        self.assertEqual(queue['records'], [])
        self.assertEqual(queue['counts'], {'eligible': 0, 'due': 0, 'unassessed': 0, 'upcoming': 0})


if __name__ == '__main__':
    unittest.main()
