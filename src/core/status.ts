export type StatusMessage =
  | { type: 'STATUS_UPDATE'; text: string }
  | { type: 'DOWNLOAD_COMPLETE' }
  | { type: 'DOWNLOAD_ERROR'; error: string };

export type StatusReporter = {
  update: (text: string) => void;
  complete: () => void;
  error: (message: string) => void;
};

export function createChromeStatusReporter(): StatusReporter {
  return {
    update(text) {
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', text } as StatusMessage);
    },
    complete() {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE' } as StatusMessage);
    },
    error(message) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', error: message } as StatusMessage);
    }
  };
}
