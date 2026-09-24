// @vitest-environment jsdom
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom 25 lacks the Blob.text()/File.text() reader used by the importer.
if (typeof Blob.prototype.text !== 'function') {
  Object.defineProperty(Blob.prototype, 'text', {
    configurable: true,
    value: function text(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
  });
}

// URL.createObjectURL / revokeObjectURL are absent from jsdom.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = (): string => 'blob:fake';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = (): void => {};
}
