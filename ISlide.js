/**
 * i-slide: Web component to display inline slides
 */

/**
 * Logging function in DEBUG mode
 */
function log(...msg) {
  if (typeof DEBUG !== 'undefined') {
    console.log(...msg);
  }
}


/**
 * Default aspect ratio for slides
 */
const defaultAspectRatio = 16/9;


/**
 * Default width for the element (same as for <img> and <iframe>)
 */
const defaultWidth = 300;


/**
 * Local cache for holding fetched and parsed slide decks
 */
const cache = {};



/**
 * List of pending fetches for the cache to avoid re-entrancy issues
 */
const pendingFetch = {};

/**
 * List of pending dimensions calculations for the cache to avoid re-entrancy issues
 */
const pendingDimensions = {};

/**
 * PDF libraries
 * 
 * TODO: Manage version number separately (and integrate CSS stylesheet)
 */
const PDFScripts = {
  'pdfjsLib': {
    url: 'https://unpkg.com/pdfjs-dist@2.9.359/build/pdf.js',
    obj: 'pdfjs-dist/build/pdf'
  },
  'pdfjsViewer': {
    url: 'https://unpkg.com/pdfjs-dist@2.9.359/web/pdf_viewer.js',
    obj: 'pdfjs-dist/web/pdf_viewer'
  }
};


/**
 * Whether PDF scripts are being or have been handled, and promise that they
 * are available.
 */
let PDFScriptsHandled = false;
let resolvePDFScriptsPromise;
const PDFScriptsLoaded = new Promise((resolve, reject) => {
  resolvePDFScriptsPromise = resolve;
});


/**
 * The i-slide Web component
 */
class ISlide extends HTMLElement {
  /**
   * A fetch-and-render cycle has been scheduled to run during next tick
   */
  #renderCyclePlanned = false;

  /**
   * ID of the current fetch-and-render cycle (increment with each cycle)
   */
  #renderCycleID = 0;

  /**
   * Promise always set, resolved when the #render function may run
   * (used to prevent re-entrancy)
   */
  #renderPossible = Promise.resolve();


  /**
   * Reflects the "src" attribute (slide source)
   */
  #src = this.baseURI;
  get src() {
    return this.#src;
  }
  set src(value) {
    const oldValue = this.#src;
    if (value) {
      try {
        this.#src = new URL(value, this.baseURI).href;
      }
      catch {
        value = '';
        this.#src = this.baseURI;
      }
    }
    else {
      this.#src = this.baseURI;
    }

    // Propagate the value to the HTML if change came from JS
    if (this.getAttribute('src') !== value) {
      this.setAttribute('src', value);
    }

    // Trigger a fetch-and-render cycle on next tick if value changed, unless
    // that's already planned
    if ((this.#src !== oldValue) && !this.#renderCyclePlanned) {
      this.#renderCyclePlanned = true;
      setTimeout(_ => this.#fetchAndRender(), 0);
    }
  }

  /**
   * Reflects the "srcref" attribute (slide source)
   */
  #srcref = "";
  get srcref() {
    return this.#src;
  }
  set srcref(value) {
    const oldValue = this.#srcref;
    if (value) {
      const id = value.split("#")[0];
      const el = document.getElementById(id);
      if (el?.href) {
	this.#srcref = value;
	this.#loadPDFScripts();
      } else {
	value = '';
      }
    }
    // Propagate the value to the HTML if change came from JS
    if (this.getAttribute('srcref') !== value) {
      this.setAttribute('srcref', value);
    }

    // Trigger a fetch-and-render cycle on next tick if value changed, unless
    // that's already planned
    if ((this.#srcref !== oldValue) && !this.#renderCyclePlanned) {
      this.#renderCyclePlanned = true;
      setTimeout(_ => this.#fetchAndRender(), 0);
    }
  }


  /**
   * Reflects the "width" attribute (width of the custom element)
   */
  #width = defaultWidth;
  get width() {
    return this.#width;
  }
  set width(value) {
    value = '' + value;
    const oldValue = this.#width;
    try {
      this.#width = parseInt(value, 10);
    }
    catch {
      value = '';
      this.#width = defaultWidth;
    }

    // Propagate the value to the HTML if change came from JS
    if (this.getAttribute('width') !== value) {
      this.setAttribute('width', value);
    }

    // Changing the width should trigger a rescale of the content, unless
    // a render is already planned, or unless a fetch is needed (in other words
    // unless no fetch-and-render cycle has started yet)
    if ((this.#width !== oldValue) && !this.#renderCyclePlanned &&
        (this.#renderCycleID > 0)) {
      this.#scaleContent({ width: this.#width });
    }
  }


  /**
   * Reflects the "height" attribute (height of the custom element)
   */
  #height = null;
  get height() {
    return this.#height;
  }
  set height(value) {
    value = '' + value;
    const oldValue = this.#height;
    try {
      this.#height = parseInt(value, 10);
    }
    catch {
      value = '';
      this.#height = null;
    }

    // Propagate the value to the HTML if change came from JS
    if (this.getAttribute('height') !== value) {
      this.setAttribute('height', value);
    }

    // Changing the height should trigger a rescale of the content, unless
    // a render is already planned, or unless a fetch is needed (in other words
    // unless no fetch-and-render cycle has started yet)
    if ((this.#height !== oldValue) && !this.#renderCyclePlanned &&
        (this.#renderCycleID > 0)) {
      this.#scaleContent({ height: this.#height });
    }
  }


  /**
   * Reflects the "type" attribute (explicit content-type of the slide)
   */
  #type;
  get type() {
    return this.#type;
  }
  set type(value) {
    const oldValue = this.#type;
    this.#type = value;

    // Propagate the value to the HTML if change came from JS
    if (this.getAttribute('type') !== value) {
      this.setAttribute('type', value);
    }

    // Start loading PDF scripts if needed
    if (this.#type === 'application/pdf') {
      this.#loadPDFScripts();
    }

    // Trigger a fetch-and-render cycle on next tick if value changed, unless
    // that's already planned
    if ((this.#type !== oldValue) && !this.#renderCyclePlanned) {
      this.#renderCyclePlanned = true;
      setTimeout(_ => this.#fetchAndRender(), 0);
    }
  }

  /**
   * Intrinsic slide dimensions (before any scaling gets applied)
   */
  #intrinsicWidth;
  #intrinsicHeight;

  /**
   * Resize dimensions that need to be processed once intrinsic dimensions
   * of the slide are known
   */
  #pendingWidth;
  #pendingHeight;

  /**
   * Last scale that was applied to the slide and last target dimensions
   * (the resize observer tends to fire more than once with the same dimensions,
   * these properties are used to avoid useless re-scaling operations)
   */
  #slideScale;
  #slideTargetWidth;
  #slideTargetHeight;

  /**
   * Current slide number (result of parsing the fragment part of the src URL)
   */
  #slideNumber;

  /**
   * Effective root element that contains the slide
   * (used to apply rescaling)
   */
  #slideEl;

  /**
   * Link to the <style> element that contains :host styles
   */
  #hostStyleEl;

  /**
   * Reference to the current PDF page if current slide is from a PDF document
   */
  #pdfPage;

  loaded;

  /**
   * Observe changes on "src" and "width" attributes.
   */
  static get observedAttributes() { return ['src', 'srcref', 'width', 'height', 'type']; }


  /**
   * Construct the object.
   * 
   * The constructor creates the shadow root. When the constructor gets called,
   * attributes may not be set yet, so no need to try and render something at
   * this stage. The "attributedChangedCallback" function will get called
   * automatically when attributes get parsed.
   */
  constructor() {
    super();
    this.loaded = false;
    this.attachShadow({ mode: 'open' });

    // Scale content when element gets resized, unless a render is already
    // planned, or unless a fetch is needed (in other words unless no
    // fetch-and-render cycle has started yet)
    const resizeObserver = new ResizeObserver(entries => {
      if (!this.#renderCyclePlanned && (this.#renderCycleID > 0)) {
        this.#scaleContent({
          width: entries[0].contentRect.width,
          height: entries[0].contentRect.height
        });
      }
    });

    resizeObserver.observe(this);
  }


  /**
   * Run a new fetch-and-render cycle
   */
  async #fetchAndRender() {
    const cycleId = ++this.#renderCycleID;

    // Cycle is no longer pending, we're handling it
    this.#renderCyclePlanned = false;

    // Tell assistive technology that we're starting a cycle that will update
    // the contents of the shadow tree
    this.setAttribute('aria-busy', true);

    // Load slides
    await this.#fetch();

    if (this.#renderCyclePlanned || (this.#renderCycleID !== cycleId)) {
      // Meanwhile, in Veracruz, someone changed an attribute, and change means
      // that another full fetch-and-render cycle needs to run, or that a cycle
      // has already started to run. No need to finish this cycle.
      return;
    }

    // Render the requested slide
    await this.#render();

    if (this.#renderCyclePlanned || (this.#renderCycleID !== cycleId)) {
      // Meanwhile, in Veracruz, see above. We should neither reset the
      // "wai-aria" attribute nor trigger the "load" event since another cycle
      // is running or will run.
      return;
    }

    // Done with fetch-and-render cycle and no further cycle needed, tell the
    // world about it.
    this.setAttribute('aria-busy', false);
    this.loaded = true;
    this.dispatchEvent(new Event('load'));
  }


  /**
   * Retrieve the slide deck at the given src URL and populate the cache.
   */
  async #fetch() {
    // srcref is assumed to be only used for PDFs
    if (this.#srcref) {
      const cacheKey = this.#srcref.split('#')[0];
      if (cache[cacheKey]) {
	return;
      }
      const el = document.getElementById(cacheKey);
      if (!el?.href) {
	return;
      }

      // Inspired from https://stackoverflow.com/posts/12094943/revisions
      const base64Marker = "application/pdf;base64,";
      const dataUrl = new URL(el.href);
      if (dataUrl.protocol !== "data:" || !dataUrl.pathname.startsWith(base64Marker)) {
	return;
      }
      const base64 = dataUrl.pathname.substring(base64Marker.length);
      const raw = window.atob(base64);
      const bytes = new Uint8Array(new ArrayBuffer(raw.length));
      for (let i = 0; i < raw.length; i++) {
	bytes[i] = raw.charCodeAt(i);
      }
      await PDFScriptsLoaded;
      const loadingTask = window[PDFScripts.pdfjsLib.obj].getDocument(bytes);
      const pdf = await loadingTask.promise;
      cache[cacheKey] = { type: "pdf", pdf };
      return;
    }
    const docUrl = this.#src.split('#')[0];
    log('fetch', docUrl, this);

    // Retrieve slide deck from cache when possible
    if (pendingFetch[docUrl]) {
      await pendingFetch[docUrl];
    }
    if (cache[docUrl]) {
      return;
    }

    // Mark the slide deck as pending to avoid re-entrancy issues when function
    // gets called from another instance, and fetch the slide deck
    let pendingResolve;
    pendingFetch[docUrl] = new Promise(resolve => {
      pendingResolve = resolve;
    });

    try {
      const resp = await fetch(docUrl);
      if (resp.status !== 200) {
        cache[docUrl] = {
          type: 'error',
          message: `Could not fetch slide deck ${docUrl} - HTTP status code received is ${resp.status}`
        };
        return;
      }
      const contentType = resp.headers.get('Content-Type');
      // TODO: is something more robust à la https://github.com/jsdom/whatwg-mimetype needed here?
      const effectiveMimeType = contentType.split(';')[0];
      if (effectiveMimeType === 'application/pdf' ||
          // taking into account poorly configured servers
          (effectiveMimeType === 'application/octet' && docUrl.match(/\.pdf$/))) {
        this.#loadPDFScripts();
      }

      const isPDF = (this.type === 'application/pdf') || (effectiveMimeType === 'application/pdf');

      if (isPDF) {
        await PDFScriptsLoaded;
        const loadingTask = window[PDFScripts.pdfjsLib.obj].getDocument(docUrl);
        const pdf = await loadingTask.promise;
        cache[docUrl] = { type: 'pdf', pdf };
      }
      else {
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Resolve all relative links in the document
        // TODO: handle srcset for images, consider object[data]
        // TODO: handle relative URLs in inline styles
        const selector = ['src', 'href', 'poster', 'longdesc']
          .map(attr => `*[${attr}]:not([${attr}*=":"])`)
          .join(',');
        doc.querySelectorAll(selector).forEach(el => {
          const attr = el.hasAttribute('src') ? 'src' : 'href';
          const relativeUrl = el.getAttribute(attr);
          try {
            const absoluteUrl = new URL(relativeUrl, docUrl).href;
            el.setAttribute(attr, absoluteUrl);
          }
          catch {}
        });

        // TODO: Find out why fonts aren't downloaded!
        cache[docUrl] = { type: 'shower-2014', doc };
      }
    }
    catch (err) {
      cache[docUrl] = { type: 'error', message: `Could not fetch slide deck ${docUrl}: ${err.message}`, err };
    }
    finally {
      pendingResolve();
      delete pendingFetch[docUrl];
    }
  }

  // We need the slide to be rendered with its styles
  // to measure its pixel dimensions
  // We do that only once per slideset to minimize flash of resizing
  async #calculateHTMLDimensions(slideEl, stylesLoaded) {
    const docUrl = this.#src.split('#')[0];
    const cacheEntry = cache[docUrl];

    // Retrieve slide deck's width from cache when possible
    if (pendingDimensions[docUrl]) {
      await pendingDimensions[docUrl];
    }
    if (cacheEntry.width) {
      // Record the dimensions
      this.#intrinsicWidth = cacheEntry.width;
      this.#intrinsicHeight = cacheEntry.height;
      return;
    }

    let pendingResolve;
    // Mark the dimensions as pending to avoid re-entrancy issues
    pendingDimensions[docUrl] = new Promise(res => pendingResolve = res);

    await stylesLoaded;

    // Record the dimensions for other class instances that reference the
    // same slide deck
    cacheEntry.width = slideEl.clientWidth;
    cacheEntry.height = slideEl.clientHeight;

    // Record the dimensions for this particular instance
    this.#intrinsicWidth = cacheEntry.width;
    this.#intrinsicHeight = cacheEntry.height;

    delete pendingDimensions[docUrl];
    pendingResolve();
  }

  /**
   * Forget everything known about the current slide
   */
  #resetSlide() {
    this.#slideEl = null;
    this.#slideNumber = null;
    this.#slideScale = null;
    this.#slideTargetWidth = null;
    this.#slideTargetHeight = null;
    this.#hostStyleEl = null;
    this.#hostStyleEl = null;
    this.#pdfPage = null;
    this.#intrinsicWidth = null;
    this.#intrinsicHeight = null;
    this.#pendingWidth = null;
    this.#pendingHeight = null;
  }


  /**
   * Render the requested slide
   */
  async #render() {
    // Wait until render is possible again
    await this.#renderPossible;
    log('render', this);

    // Make sure that no other render operation can run at the same time
    let resolve;
    this.#renderPossible = new Promise(res => resolve = res);

    this.#resetSlide();
    this.shadowRoot.replaceChildren();

    const src = this.#srcref || this.#src;

    const [docUrl, slideId] = src.split('#');
    const cacheEntry = cache[docUrl];

    // Initial width is explicitly set
    const width = this.clientWidth || this.#width;

    // Initial height may be explicitly set. If not, we'll set it from the
    // width based on the default aspect ratio, unless the slide ratio is
    // already known.
    let height = this.clientHeight || this.#height ||
      (cacheEntry.width && cacheEntry.height ?
        cacheEntry.height * width / cacheEntry.width :
        width / defaultAspectRatio);

    // Note external CSS properties may set or constrain the dimensions of the
    // custom element, but we cannot easily determine whether that is the case
    // here (as opposed to the current box dimensions being the result of the
    // dimensions of a slide that may already have been rendered). As we're
    // going to try to impose the size of the custom element through ":host"
    // properties, these additional constraints should trigger a "resize" that
    // will be handled by the ResizeObserver instance, which in turn will resize
    // the slide to the right scale.

    // Styles for the custom element itself
    this.#hostStyleEl = document.createElement('style');
    this.#hostStyleEl.textContent = this.#getHostStyles(width, height);

    try {
      if (cacheEntry.type === 'error') {
        throw new Error(cacheEntry.message);
      }

      if (cacheEntry.type === 'pdf') {
        const m = slideId.match(/^(page=)?(\d+)$/);
        if (!m) throw new Error(`Unrecognized PDF fragment ${slideId}`);
        this.#slideNumber = parseInt(m[2], 10);

        const styleEl = document.createElement('link');
        styleEl.rel = 'stylesheet';
        styleEl.href = 'https://unpkg.com/pdfjs-dist@2.9.359/web/pdf_viewer.css';

        this.#slideEl = document.createElement('div');
        // Needed to properly position the annotation layer (e.g. links)
        this.#slideEl.style.position = "relative";
        this.#slideEl.style.overflow = "hidden";

        this.shadowRoot.append(this.#hostStyleEl, styleEl, this.#slideEl);

        const pdf = cacheEntry.pdf;
        this.#pdfPage = await pdf.getPage(this.#slideNumber);

        // Save intrinsic dimensions of the current slide
        this.#intrinsicWidth = this.#pdfPage.view[2];
        this.#intrinsicHeight = this.#pdfPage.view[3];

        // Note that the PDF slide gets rendered when it is scaled up/down to
        // the right dimensions in #scaleContent
      }
      else {
        const { type, doc } = cache[docUrl];
	const newdoc = doc.cloneNode(true);
	const headEl = newdoc.querySelector('head');
	const bodyEl = newdoc.querySelector('body');
        const slideNumber = parseInt(slideId, 10);
        const slideEl = newdoc.getElementById(slideId) ||
              newdoc.querySelectorAll('.slide')[slideNumber - 1];
        if (!slideEl) throw new Error(`Could not find slide ${slideId} in ${docUrl}`);

	// Hide all other slides, emulating the way B6+ does it. If
	// the slides are for Shower, the style sheet that comes with
	// the slides does this already.
        for (const c of newdoc.querySelectorAll('.slide'))
	  if (c != slideEl) {
	    c.style.visibility = 'hidden';
	    c.style.position = "absolute";
	    c.style.top = "0";
	  }

        slideEl.style.marginLeft = '0';
        bodyEl.style.top = 'inherit';
        bodyEl.style.left = 'inherit';
        bodyEl.style.margin = 'inherit';
        bodyEl.style.transformOrigin = '0 0';

        //  Works for Shower and b6
        slideEl.classList.add('active');
        bodyEl.classList.add('full');
        bodyEl.classList.remove('list');

        // Specific to Shower with CSS Variables
        slideEl.style.setProperty('--slide-scale', 1);

        const styleLoadedPromises = [];
        [...headEl.querySelectorAll("link[rel~=stylesheet]")].map(l => {
          let resolve;
          const p = new Promise((res) => resolve = res);
          l.addEventListener("load", resolve);
          l.addEventListener("error", resolve);
          styleLoadedPromises.push(p);
        });

        // Attach HTML document to shadow root, making sure that the content
        // cannot overflow the <i-slide> element (the height of the <html>
        // element must be specified because <body> is absoluted positioned in
        // Shower.js, so height of <html> would be 0 otherwise)
        this.#slideEl = document.createElement('html');
        this.#slideEl.style.position = 'relative';
        this.#slideEl.style.overflow = 'hidden';
        this.#slideEl.style.height = `${height}px`;
        headEl.appendChild(this.#hostStyleEl);

        if (!cacheEntry.width) {
          // Nothing known about intrinsic slide dimensions for now,
          // hide the slide on the left to avoid showing bogusly scaled content
          slideEl.style.marginLeft = "-2000px";
        }

        this.#slideEl.appendChild(headEl);
        this.#slideEl.appendChild(bodyEl);
        this.shadowRoot.append(this.#slideEl);

        if (cacheEntry.width) {
          this.#intrinsicWidth = cacheEntry.width;
          this.#intrinsicHeight = cacheEntry.height;
        }
        else {
          // Wait until we get the dimensions of the slide
          // and move slide element back in the flow
          await this.#calculateHTMLDimensions(slideEl, Promise.all(styleLoadedPromises));
          slideEl.style.marginLeft = "inherit";

          // Adjust height now that we know the intrinsic dimensions of the
          // slide
          height = cacheEntry.height * width / cacheEntry.width;
        }
      }

      // Render and rescale content accordingly
      await this.#scaleContent();
    } catch (err) {
      console.error(err.toString(), err);
      this.shadowRoot.innerHTML = "";
      this.#slideEl = document.createElement('div');
      this.#slideEl.innerHTML = this.innerHTML.trim() || `<a href="${this.src}">${this.src}</a>`;
      this.shadowRoot.append(this.#hostStyleEl, this.#slideEl);
    }
    finally {
      // Release the #renderPossible lock
      resolve();
    }
  }


  /**
   * Listen to attribute changes and render slide appropriately.
   * 
   * Calling the property setters may may trigger asynchronous steps such as
   * network I/O to fetch the slides.
   *
   * Note the function gets called when attributes are initialized.
   */
  attributeChangedCallback(name, oldValue, newValue) {
    switch (name) {
      case 'src':
        this.src = newValue;
        break;
      case 'srcref':
        this.srcref = newValue;
        break;
      case 'type':
        this.type = newValue;
        break;
      case 'width':
        this.width = newValue;
        break;
      case 'height':
        this.height = newValue;
        break;
    }
  }


  /**
   * Load PDF.js libraries
   */
  async #loadPDFScripts() {
    if (PDFScriptsHandled) {
      return;
    }
    PDFScriptsHandled = true;

    for (const { url, obj } of Object.values(PDFScripts)) {
      if (window[obj]) {
        continue;
      }

      const scriptEl = document.createElement('script');
      scriptEl.src = url;

      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      scriptEl.addEventListener('load', resolvePromise);
      scriptEl.addEventListener('error', rejectPromise)
      document.body.appendChild(scriptEl);

      await promise;
    }

    // TODO: move hard-coded URL elsewhere
    window[PDFScripts.pdfjsLib.obj].GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@2.9.359/build/pdf.worker.js';

    resolvePDFScriptsPromise();
  }

  /**
   * Retrieve styles to be applied to the custom element to create something
   * that is as close as possible to a "replaced element" in CSS:
   * - custom element is an inline-block element
   * - width is imposed (300px by default)
   * - height is determined based on the intrinsic slide aspect ratio, or
   * imposed (initially to avoid reflows, or explicitly through CSS properties)
   * - also, "hidden" attribute needs to be accounted for explicitly
   */
  #getHostStyles(width, height) {
    const heightProp = height ? `
      height: ${height === 'auto' ? 'auto' : height + 'px'};
    ` : '';

    return `
      :host {
        display: inline-block;
        width: ${width === 'auto' ? 'auto': width + 'px'};
        ${heightProp}
        overflow: hidden;
      }
      :host([hidden]) {
        display: none;
      }
    `;
  }

  /**
   * Scale the intrinsic content to fit the requested box
   *
   * TODO: Add support for "object-fit" and "object-position" properties, to be
   * passed as function parameters. Currently, the function assumes that the
   * following directives always apply:
   *   object-fit: contain (proper default should rather be "fill")
   *   object-position: top left (proper default should rather be "50% 50%")
   */
  async #scaleContent(box) {
    box = box || {};
    const logPrefix = `scaleContent(${box.width} x ${box.height})`

    // Function may have been called through the resize observer before the
    // intrinsic dimensions of the slide are known. In this case, we need to
    // keep these dimensions in mind and apply them once intrinsic dimensions
    // are known and that function gets called again without arguments (which
    // is exactly what #render() does)
    if (!this.#intrinsicWidth || !this.#intrinsicHeight) {
      this.#pendingWidth = box.width;
      this.#pendingHeight = box.height;
      log(logPrefix, 'mark as pending');
      return;
    }

    // Compute the dimensions of the i-slide element in the absence of
    // additional constraints, and set box dimensions that are not yet imposed.
    const targetWidth = this.clientWidth || this.#width;
    box.width = box.width || this.#pendingWidth || targetWidth;

    const targetHeight = this.clientHeight || this.#height ||
      (this.#intrinsicWidth && this.#intrinsicHeight ?
        this.#intrinsicHeight * box.width / this.#intrinsicWidth :
        box.width / defaultAspectRatio);
    box.height = box.height || this.#pendingHeight || targetHeight;

    // Reset pending resize if needed
    this.#pendingWidth = null;
    this.#pendingHeight = null;

    // Compute the scale for slide to fit in the box
    // (Note the need to convert from CSS points to CSS pixels for PDF slides)
    const scale = Math.min(
      box.height / this.#intrinsicHeight,
      box.width / this.#intrinsicWidth) * (this.#pdfPage ? 72 / 96 : 1);

    // No need to scale content if scale is already the right one
    if ((this.#slideScale === scale) &&
        (this.#slideTargetWidth === targetWidth) &&
        (this.#slideTargetHeight === targetHeight)) {
      log(logPrefix, 'not needed');
      return;
    }
    log(logPrefix, `scale:${this.#slideScale}=>${scale}`,
      `width:${this.#slideTargetWidth}=>${targetWidth}`,
      `height:${this.#slideTargetHeight}=>${targetHeight}`);
    this.#slideScale = scale;
    this.#slideTargetWidth = targetWidth;
    this.#slideTargetHeight = targetHeight;

    if (this.#pdfPage) {
      // Slide to render is a PDF slide
      const pdfjsViewer = window[PDFScripts.pdfjsViewer.obj];

      // Drop PDF content that may already have been rendered
      this.#slideEl.replaceChildren();

      // Make slides fit the desired dimensions of the component
      const viewport = this.#pdfPage.getViewport({ scale });
      const pdfPageView = new pdfjsViewer.PDFPageView({
        container: this.#slideEl,
        id: this.#slideNumber,
        scale: scale,
        defaultViewport: viewport,
        eventBus: new pdfjsViewer.EventBus(),
        textLayerFactory: new pdfjsViewer.DefaultTextLayerFactory(),
        annotationLayerFactory: new pdfjsViewer.DefaultAnnotationLayerFactory()
      });

      // Associates the actual page with the view, and draw it
      pdfPageView.setPdfPage(this.#pdfPage);
      await pdfPageView.draw();
    }
    else {
      const width = this.#intrinsicWidth * scale;
      const height = this.#intrinsicHeight * scale;

      this.#slideEl.style.width = `${width}px`;
      this.#slideEl.style.height = `${height}px`;

      // Note <body> is not set when an error occurred
      const body = this.#slideEl.querySelector('body');
      if (body) {
        body.style.transform = `scale(${scale})`;
      }
      else {
        // An error means we fallback to the inner HTML content, so no intrinsic
        // dimensions anymore. Or should we rather stick to the requested width
        // and height as for <img>?
        this.#slideEl.style.width = 'auto';
        this.#slideEl.style.height = 'auto';
        this.#hostStyleEl.textContent = this.#getHostStyles('auto', 'auto');
        return;
      }
    }

    // Set the targeted dimensions (note CSS properties may further constrain
    // the actual dimensions of the element, overriding the width and height
    // set at the :host level. That is good, these directives tell the browser
    // to resize the element to the right dimensions when these constraints
    // change or disappear).
    this.#hostStyleEl.textContent = this.#getHostStyles(targetWidth, targetHeight);
  }
}

export default ISlide;
