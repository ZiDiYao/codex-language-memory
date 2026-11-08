import { reveal, conceal } from "./motion.js";

/** Small accessible listbox with the same styling as the surrounding page. */
export class Picker {
  constructor(host, { label, options = [], value = "", onChange }) {
    this.host = host;
    this.label = label;
    this.options = options;
    this.value = value;
    this.onChange = onChange;
    this.expanded = false;
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "picker-trigger";
    this.button.setAttribute("role", "combobox");
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    this.list = document.createElement("div");
    this.list.id = host.id + "-options";
    this.list.className = "picker-options";
    this.list.setAttribute("role", "listbox");
    this.list.hidden = true;
    this.button.setAttribute("aria-controls", this.list.id);
    host.classList.add("picker");
    host.append(this.button, this.list);
    this.button.addEventListener("click", () =>
      this.expanded ? this.close(true) : this.open(),
    );
    this.button.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        this.open();
      }
    });
    this.list.addEventListener("keydown", (event) => {
      const buttons = [...this.list.children];
      let index = buttons.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
        return;
      }
      if (event.key === "Tab") return this.close(true);
      if (event.key === "ArrowDown") index = (index + 1) % buttons.length;
      else if (event.key === "ArrowUp")
        index = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = buttons.length - 1;
      else if (event.key.length === 1 && event.key !== " ") {
        index = this.options.findIndex((option) =>
          option.label
            .toLocaleLowerCase()
            .startsWith(event.key.toLocaleLowerCase()),
        );
      } else return;
      event.preventDefault();
      buttons[index]?.focus();
    });
    document.addEventListener("click", (event) => {
      if (!host.contains(event.target)) this.close();
    });
    host.addEventListener("focusout", (event) => {
      if (!this.rendering && !host.contains(event.relatedTarget)) this.close();
    });
    this.render();
  }

  setOptions(options) {
    if (JSON.stringify(options) === JSON.stringify(this.options)) return;
    this.options = options;
    this.render();
  }

  setValue(value) {
    if (this.value === value) return;
    this.value = value;
    this.render();
  }

  setLabel(label) {
    this.label = label;
    this.button.setAttribute("aria-label", label);
    this.list.setAttribute("aria-label", label);
  }

  render() {
    this.rendering = true;
    const focusedIndex = [...this.list.children].indexOf(document.activeElement);
    this.button.setAttribute("aria-label", this.label);
    this.list.setAttribute("aria-label", this.label);
    this.button.textContent =
      this.options.find((option) => option.value === this.value)?.label ||
      this.label;
    this.list.replaceChildren(
      ...this.options.map((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.setAttribute("role", "option");
        button.setAttribute(
          "aria-selected",
          String(option.value === this.value),
        );
        const label = document.createElement("span");
        label.textContent = option.label;
        button.append(label);
        if (option.count !== undefined) {
          const count = document.createElement("small");
          count.textContent = option.count;
          button.append(count);
        }
        button.addEventListener("click", () => {
          this.close(true);
          this.value = option.value;
          this.render();
          this.onChange?.(option.value);
        });
        return button;
      }),
    );
    if (this.expanded && focusedIndex >= 0) this.list.children[focusedIndex]?.focus();
    this.rendering = false;
  }

  open() {
    if (!this.options.length) return;
    if (this.expanded) return;
    this.expanded = true;
    reveal(this.list);
    this.button.setAttribute("aria-expanded", "true");
    (
      this.list.querySelector('[aria-selected="true"]') ||
      this.list.firstElementChild
    ).focus();
  }

  close(focus = false) {
    if (!this.expanded) return;
    this.expanded = false;
    this.button.setAttribute("aria-expanded", "false");
    conceal(this.list);
    if (focus) this.button.focus();
  }
}
