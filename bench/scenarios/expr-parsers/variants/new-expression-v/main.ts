class Box<T> {
    constructor(
        public value: T,
        public label: string,
    ) {}
}

const box = new Box<number>(1, "one");

export type BoxInstance = typeof box;
