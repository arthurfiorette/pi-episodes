export interface BridgedContainer {
    item: import("./other").Thing<number, boolean>;
    bridged: import("./bridge").Thing<string, string>;
}
