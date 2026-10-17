#!/usr/bin/env node
/**
 * fetch-page.js - Fetch a URL using Playwright and extract readable content as markdown
 * 
 * Usage: node fetch-page.js <url> [output-file]
 * 
 * Examples:
 *   node fetch-page.js https://boardgamegeek.com
 *   node fetch-page.js https://boardgamegeek.com hotness.md
 */

const { chromium } = require('playwright');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { JSDOM } = require('jsdom');

async function fetchPage(url, outputFile) {
  console.log(`Fetching: ${url}`);
  
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Set a realistic user agent
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });
  
  await page.goto(url, { 
    waitUntil: 'networkidle',
    timeout: 30000 
  });
  
  // Wait a bit more for any lazy-loaded content
  await page.waitForTimeout(2000);
  
  const title = await page.title();
  console.log(`Title: ${title}`);
  
  // Get the full HTML
  const html = await page.content();
  
  // Parse with Readability using JSDOM
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  
  if (!article) {
    console.error('Failed to parse article content');
    await browser.close();
    process.exit(1);
  }
  
  // Convert to markdown
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
  });
  
  // Add custom rule to preserve images
  turndown.addRule('images', {
    filter: 'img',
    replacement: (content, node) => {
      const alt = node.alt || '';
      const src = node.src || '';
      return `![${alt}](${src})`;
    }
  });
  
  const markdown = turndown.turndown(article.content);
  
  // Add frontmatter
  const frontmatter = `---
title: "${article.title || title}"
source: "${url}"
fetched: "${new Date().toISOString()}"
excerpt: "${(article.excerpt || '').replace(/"/g, '\\"')}"
---

`;
  
  const fullContent = frontmatter + markdown;
  
  if (outputFile) {
    const fs = require('fs');
    fs.writeFileSync(outputFile, fullContent);
    console.log(`Saved to: ${outputFile}`);
  } else {
    console.log('\n' + '='.repeat(80));
    console.log('CONTENT:');
    console.log('='.repeat(80) + '\n');
    console.log(fullContent);
  }
  
  await browser.close();
}

// Run if called directly
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: node fetch-page.js <url> [output-file]');
  console.log('Example: node fetch-page.js https://boardgamegeek.com');
  process.exit(1);
}

const url = args[0];
const outputFile = args[1];

fetchPage(url, outputFile).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
