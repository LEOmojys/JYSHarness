/** Todo list state, exposed to the model as the TodoWrite tool. */
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export class TodoStore {
  items: TodoItem[] = [];

  set(items: TodoItem[]): void {
    this.items = items;
  }

  summary(): string {
    if (!this.items.length) return "todo list is empty";
    const done = this.items.filter((t) => t.status === "completed").length;
    return this.items.map((t) => "- [" + (t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " ") + "] " + t.content).join("\n") +
      "\n(" + done + "/" + this.items.length + " done)";
  }
}
