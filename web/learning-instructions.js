export const LEARNING_INSTRUCTIONS_LIMIT = 1500;

// Match the service's Python-compatible whitespace normalization, including NEL
// and information separators while preserving BOM characters.
export function normalizeLearningInstructions(value) {
  return value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
}

export function validLearningInstructions(value) {
  return typeof value === "string" && [...normalizeLearningInstructions(value)].length <= LEARNING_INSTRUCTIONS_LIMIT &&
    [...value].every((letter) => letter !== "\0" && !(letter.length === 1 && letter.charCodeAt(0) >= 0xd800 && letter.charCodeAt(0) <= 0xdfff));
}

/** An explicit-save draft, scoped to the current signed-in account. */
export class LearningInstructionsDraft {
  constructor({ save, onState = () => {} }) {
    this.write = save;
    this.onState = onState;
    this.generation = 0;
    this.available = false;
    this.confirmed = this.value = "";
    this.pending = null;
    this.message = null;
    this.error = false;
  }

  get dirty() { return this.value !== this.confirmed; }
  notify() { this.onState(this); }

  load(settings) {
    const dirty = this.dirty;
    const next = typeof settings?.english_learning_instructions === "string" ? settings.english_learning_instructions : "";
    this.available = settings?._capabilities?.custom_learning_instructions === true;
    if (!dirty) this.value = next;
    else if (next !== this.confirmed && !this.pending) this.message = "learningInstructionsChanged";
    this.confirmed = next;
    this.notify();
  }

  edit(value) {
    this.value = value;
    this.message = this.error = null;
    this.notify();
  }

  save(force = false) {
    if (this.pending) return this.pending;
    if (!this.available || !validLearningInstructions(this.value)) {
      this.message = this.available ? "learningInstructionsInvalid" : "learningInstructionsUnavailable";
      this.error = true;
      this.notify();
      return Promise.resolve(false);
    }
    if (!this.dirty && !force && !this.error) return Promise.resolve(true);
    const generation = this.generation, draft = this.value, submitted = normalizeLearningInstructions(draft);
    this.message = "saving";
    this.error = false;
    const writing = (async () => {
      // Set pending before calling the shared settings queue, even for an immediate test transport.
      await Promise.resolve();
      try {
        const settings = await this.write({ english_learning_instructions: submitted });
        if (generation !== this.generation) return false;
        if (settings?.english_learning_instructions !== submitted) throw new Error("unconfirmed");
        this.confirmed = submitted;
        if (this.value === draft) this.value = submitted;
        this.message = this.dirty ? "learningInstructionsUnsaved" : "learningInstructionsSaved";
        return true;
      } catch {
        if (generation !== this.generation) return false;
        this.message = "learningInstructionsSaveFailed";
        this.error = true;
        return false;
      } finally {
        if (generation === this.generation) {
          this.pending = null;
          this.notify();
        }
      }
    })();
    this.pending = writing;
    this.notify();
    return writing;
  }

  clear() {
    if (this.pending) return this.pending;
    this.edit("");
    return this.save(true);
  }

  async flush() {
    if (this.pending && !(await this.pending)) return false;
    return !this.dirty || this.save();
  }

  invalidate() {
    ++this.generation;
    this.available = false;
    this.pending = null;
    this.confirmed = this.value = "";
    this.message = null;
    this.error = false;
    this.notify();
  }
}

export function createLearningInstructionsEditor(root, { save, t }) {
  const pick = (name) => root.querySelector(`[data-learning-instructions-${name}]`);
  const input = pick("input"), saveButton = pick("save"), clearButton = pick("clear"), count = pick("count"), status = pick("status");
  const render = (state) => {
    if (input.value !== state.value) input.value = state.value;
    input.disabled = !state.available;
    const valid = validLearningInstructions(state.value);
    input.setAttribute("aria-invalid", String(!valid));
    saveButton.disabled = !state.available || !!state.pending || (!state.dirty && !state.error) || !valid;
    clearButton.disabled = !state.available || !!state.pending || (!state.value && !state.confirmed);
    count.textContent = `${[...normalizeLearningInstructions(state.value)].length} / ${LEARNING_INSTRUCTIONS_LIMIT}`;
    const key = !state.available ? "learningInstructionsUnavailable" : !valid ? "learningInstructionsInvalid" :
      state.message || (state.dirty ? "learningInstructionsUnsaved" : "");
    status.textContent = key ? t(key) : "";
    status.hidden = !key;
    status.classList.toggle("error", state.error || !valid);
  };
  const draft = new LearningInstructionsDraft({ save, onState: render });
  input.addEventListener("input", () => draft.edit(input.value));
  saveButton.addEventListener("click", () => void draft.save());
  clearButton.addEventListener("click", () => void draft.clear());
  draft.relabel = () => render(draft);
  draft.notify();
  return draft;
}
