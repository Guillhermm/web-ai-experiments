// Opened straight from disk there is no server to turn a folder into its index.html, so the clean
// folder links would show a directory listing. Only then are they pointed at the page itself.
const linkFoldersToIndex = (doc) => {
	if (doc.location.protocol !== 'file:') return;
	doc.querySelectorAll('a[href^="./"][href$="/"]').forEach((a) => {
		a.setAttribute('href', `${a.getAttribute('href')}index.html`);
	});
};

linkFoldersToIndex(document);
