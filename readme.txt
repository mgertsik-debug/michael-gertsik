# Your Website — Quick Start Guide

## Files in this folder
- `index.html` — Your full website (home + blog)
- `posts.js`   — Your blog posts (edit this to publish new articles)

---

## How to publish to the web (FREE, takes ~5 minutes)

1. Go to **https://netlify.com** and create a free account
2. Once logged in, click **"Add new site" → "Deploy manually"**
3. Drag your entire `site` folder onto the upload area
4. Your site is live instantly at a free URL like `yourname.netlify.app`
5. To get a custom domain (e.g. `yourname.com`), buy one for ~$10/yr on Namecheap and connect it in Netlify settings

---

## How to add a new blog post

Open `posts.js` in any text editor (Notepad, TextEdit, VS Code, etc.)

Copy this template and paste it at the **very top** of the POSTS array (right after the first `[`):

```
{
  id: "my-post-slug-here",
  date: "March 17, 2025",
  category: "Regulation",
  title: "Your Article Title Here",
  summary: "A one or two sentence summary that shows on the blog list page.",
  content: `
    <p>Your first paragraph goes here.</p>
    <h3>A Subheading</h3>
    <p>More content here.</p>
  `
},
```

Then re-upload the updated `posts.js` file to Netlify (drag & drop again — it updates automatically).

---

## Tips
- Categories can be anything: "Regulation", "Legislation", "Market Structure", "Commentary", etc.
- The `content` field supports basic HTML: `<p>`, `<h3>`, `<em>`, `<strong>`, `<a href="...">link</a>`
- Posts appear in the order they are listed — newest first (top of array)

---

That's it! No coding required to publish new articles.
