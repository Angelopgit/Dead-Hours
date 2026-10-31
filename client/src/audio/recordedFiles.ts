/** URLs of the recorded sounds by path (Vite only: data URIs in the build). */
export const RECORDED_FILES = import.meta.glob<string>('./recorded/*.mp3', { eager: true, query: '?url', import: 'default' });
