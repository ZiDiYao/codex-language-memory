/** Cursor pagination and request ownership, independent of DOM rendering. */
export class RecordFeed {
  constructor({ fetchPage, canCommit, onStart, onCommit, onError, onFinish }) {
    Object.assign(this, { fetchPage, canCommit, onStart, onCommit, onError, onFinish });
    this.cursor = null;
    this.hasMore = true;
    this.loading = false;
    this.failed = false;
    this.version = 0;
  }

  async readPages(filters, amount, isCurrent) {
    let data = { records: [], has_more: true, next_cursor: this.cursor };
    do {
      const args = { ...filters, limit: Math.min(50, amount - data.records.length) };
      if (data.next_cursor) args.cursor = data.next_cursor;
      const batch = await this.fetchPage(args);
      data = { ...batch, records: [...data.records, ...batch.records] };
    } while (data.has_more && data.records.length < amount && isCurrent());
    return data;
  }

  async load({ reset = false, amount = 20, filters = {}, view = {} } = {}) {
    if (!reset && (this.loading || !this.hasMore || this.failed)) return false;
    const version = reset ? ++this.version : this.version;
    const isCurrent = () => version === this.version;
    if (reset) {
      this.cursor = null;
      this.hasMore = true;
      this.failed = false;
    }
    this.loading = true;
    try {
      this.onStart(view);
      const data = await this.readPages({ ...filters }, amount, isCurrent);
      // An old response must not replace a newer search or an unsaved edit.
      if (!isCurrent() || !this.canCommit(view)) return false;
      this.onCommit(data, view);
      this.cursor = data.next_cursor;
      this.hasMore = data.has_more;
      return true;
    } catch (error) {
      if (isCurrent()) {
        this.failed = true;
        this.onError(error);
      }
      return false;
    } finally {
      // Only the current request owns the loading indicator and retry state.
      if (isCurrent()) {
        this.loading = false;
        this.onFinish();
      }
    }
  }
}
