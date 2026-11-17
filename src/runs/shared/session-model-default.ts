import * as path from "node:path";

/** Session-local model default, isolated by the request's normalized cwd. */
export class SessionModelDefaultStore {
	private readonly defaults = new Map<string, string>();

	get(cwd: string): string | undefined {
		return this.defaults.get(path.resolve(cwd));
	}

	set(cwd: string, model: string | undefined): void {
		const key = path.resolve(cwd);
		if (model === undefined) this.defaults.delete(key);
		else this.defaults.set(key, model);
	}

	clear(): void {
		this.defaults.clear();
	}
}
