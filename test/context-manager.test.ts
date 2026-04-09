import { ContextManager } from '../src/services/context-manager';

// Mock dependencies
const mockApp = {
    workspace: {
        getActiveFile: () => null
    },
    vault: {
        read: async () => "File Content"
    }
} as any;

// Mock global requestUrl
(global as any).requestUrl = async (options: any) => {
    if (options.url.includes('youtube.com')) {
        return { text: 'YouTube Page' };
    }
    return { text: '<html><body><h1>Web Page Title</h1><p>Web Page Content</p></body></html>' };
};

// Mock video_utils
jest.mock('../src/utils/video_utils', () => ({
    getVideoTranscript: async (url: string) => {
        if (url.includes('youtube')) {
            return {
                title: 'YouTube Video',
                text: 'Transcript text here',
                platform: 'youtube'
            };
        }
        return null;
    }
}));

describe('ContextManager', () => {
    let contextManager: ContextManager;

    beforeEach(() => {
        contextManager = new ContextManager(mockApp);
    });

    test('should add and remove context items', () => {
        contextManager.addContext('image', 'test.png', 'base64data');
        expect(contextManager.getContexts().length).toBe(1);
        expect(contextManager.getContexts()[0].type).toBe('image');

        contextManager.removeContext(0);
        expect(contextManager.getContexts().length).toBe(0);
    });

    test('should resolve web url context', async () => {
        contextManager.addContext('url', 'https://example.com');
        const contexts = await contextManager.resolveContexts();

        expect(contexts.length).toBe(1);
        expect(contexts[0].content).toContain('Web Page Title');
        expect(contexts[0].content).toContain('Web Page Content');
    });

    test('should resolve youtube context', async () => {
        contextManager.addContext('url', 'https://youtube.com/watch?v=123');
        const contexts = await contextManager.resolveContexts();

        expect(contexts.length).toBe(1);
        expect(contexts[0].type).toBe('youtube');
        expect(contexts[0].content).toContain('Transcript text here');
    });
});
