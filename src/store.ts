/**
 * store.ts
 * Lightweight reactive store for process state.
 * Swap the internals for @zuzjs/store without touching the API.
 */

import EventEmitter from "node:events";
import { ManagedProcess } from "./types.js";

type StoreListener<T> = (key: string, value: T) => void;

class Store<T> extends EventEmitter {
  private map = new Map<string, T>();

  set(key: string, value: T): void {
    this.map.set(key, value);
    this.emit("change", key, value);
  }

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): void {
    this.map.delete(key);
    this.emit("delete", key);
  }

  all(): Map<string, T> {
    return new Map(this.map);
  }

  onchange(listener: StoreListener<T>): this {
    return this.on("change", listener);
  }

  offchange(listener: StoreListener<T>): this {
    return this.off("change", listener);
  }
}

/** Singleton process store – one entry per managed worker name */
export const processStore = new Store<ManagedProcess>();
