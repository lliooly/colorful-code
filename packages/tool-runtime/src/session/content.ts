export type TextContentBlock = {
  type: 'text';
  text: string;
};

export type ImageContentBlock = {
  type: 'image';
  mediaType: string;
  data: string;
};

export type ContentBlock = TextContentBlock | ImageContentBlock;

export type MessageContent = string | ContentBlock[];

export function contentBlocks(content: MessageContent): ContentBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  return content;
}

export function contentToText(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      return '[image: ' + block.mediaType + ']';
    })
    .join('\n');
}

export function prependTextToContent(
  prefix: string,
  content: MessageContent,
): MessageContent {
  if (typeof content === 'string') {
    return prefix + content;
  }
  return [{ type: 'text', text: prefix }, ...content];
}
