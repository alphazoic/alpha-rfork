// Package mega provides an interface to the Mega
// object storage system.
package mega

/*
Open questions
* Does mega support a content hash - what exactly are the mega hashes?
* Can mega support setting modification times?

Improvements:
* Downloads would be more efficient done in one go
* Uploads would be more efficient with bigger chunks
* Looks like mega can support server-side copy, but it isn't implemented in go-mega
* Upload can set modtime... - set as int64_t - can set ctime and mtime?
*/

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/fserrors"
	"github.com/rclone/rclone/fs/fshttp"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/lib/encoder"
	"github.com/rclone/rclone/lib/pacer"
	"github.com/rclone/rclone/lib/readers"
	mega "github.com/t3rm1n4l/go-mega"
	"golang.org/x/sync/errgroup"
)

const (
	minSleep      = 10 * time.Millisecond
	maxSleep      = 2 * time.Second
	eventWaitTime = 500 * time.Millisecond
	decayConstant = 2 // bigger for slower decay, exponential

	sessionIDConfigKey   = "session_id"
	masterKeyConfigKey   = "master_key"
	maxUploadRequestSize = 64 * 1024 * 1024
)

var (
	megaCacheMu sync.Mutex                // mutex for the below
	megaCache   = map[string]*mega.Mega{} // cache logged in Mega's by user
)

// Register with Fs
func init() {
	fs.Register(&fs.RegInfo{
		Name:        "mega",
		Description: "Mega",
		NewFs:       NewFs,
		Options: []fs.Option{{
			Name:      "user",
			Help:      "User name.",
			Required:  true,
			Sensitive: true,
		}, {
			Name:       "pass",
			Help:       "Password.",
			Required:   true,
			IsPassword: true,
		}, {
			Name:     "2fa",
			Help:     `The 2FA code of your MEGA account if the account is set up with one`,
			Required: false,
		}, {
			Name:      sessionIDConfigKey,
			Help:      "Session (internal use only)",
			Required:  false,
			Advanced:  true,
			Sensitive: true,
			Hide:      fs.OptionHideBoth,
		}, {
			Name:      masterKeyConfigKey,
			Help:      "Master key (internal use only)",
			Required:  false,
			Advanced:  true,
			Sensitive: true,
			Hide:      fs.OptionHideBoth,
		}, {
			Name: "debug",
			Help: `Output more debug from Mega.

If this flag is set (along with -vv) it will print further debugging
information from the mega backend.`,
			Default:  false,
			Advanced: true,
		}, {
			Name: "upload_retries",
			Help: `Additional attempts for a transient upload-data request.

Use -1 to inherit --low-level-retries. Zero disables data-request retries.
This setting applies per file, including when accounts share an API client.
It does not enable replay of an uncertain final file commit.`,
			Default:  -1,
			Advanced: true,
		}, {
			Name: "upload_retry_body_errors",
			Help: `Allow ciphertext replay after an incomplete upload response body.

Experimental: a lost terminal response may contain the upload completion handle.
Terminal replay passed a small live protocol probe; this remains opt-in for
compatibility while broader failure and native-platform checks are completed.
The per-request retry budget still applies. Final file commits are never replayed.`,
			Default:  false,
			Advanced: true,
		}, {
			Name: "hard_delete",
			Help: `Delete files permanently rather than putting them into the trash.

Normally the mega backend will put all deletions into the trash rather
than permanently deleting them.  If you specify this then rclone will
permanently delete objects instead.`,
			Default:  false,
			Advanced: true,
		}, {
			Name: "upload_concurrency",
			Help: `Number of native MEGA chunks uploaded concurrently per file.

This is independent of --transfers, which controls simultaneous files.
Values from 1 to 32 are accepted. The worker pool holds at most concurrency+1
request buffers, up to 1 MiB each with native requests or upload_request_size
with batching. Encryption, transport and rclone's read buffer add overhead.
Use 1 for serial uploads.`,
			Default:  8,
			Advanced: true,
		}, {
			Name: "upload_request_size",
			Help: `Maximum payload of a batched MEGA data request.

Zero disables batching and sends one native chunk per request (compatibility
default). Nonzero sizes from 1Mi to 64Mi group complete contiguous native chunks;
actual requests may be shorter to preserve native crypto boundaries and EOF.
Use explicit units (for example 4Mi or 4194304B); bare numbers mean KiB.
The per-file payload-buffer bound is (upload_concurrency+1) times this size,
plus up to 1 MiB encryption scratch per worker, MAC state, rclone read buffers
and transport/runtime overhead. Simultaneous files multiply these costs.
Generic --max-buffer-memory does not cap these payload buffers.`,
			Default:  fs.SizeSuffix(0),
			Advanced: true,
		}, {
			Name: "upload_diagnostics",
			Help: `Emit a bounded aggregate diagnostic report for each upload attempt.

Reports contain settings, timing and byte counters, without file names, upload
URLs or keys. With --use-json-log the report is in the megaUpload field.
Worker timing totals overlap and are not elapsed wall time. HTTP payload reads
include retries and are not TCP/TLS byte counts. Acknowledged chunks alone do
not establish a successful file commit. Collection is disabled by default.`,
			Default:  false,
			Advanced: true,
		}, {
			Name: "upload_pacing",
			Help: `Minimum interval between upload-data request starts on this backend.

Accepts a nonnegative duration, for example 10ms or 0. Zero disables data pacing;
worker counts, --max-connections, bandwidth limits and global HTTP limits still
apply. The interval is shared by simultaneous files using this backend, not by
separately configured remotes sharing an account. Retries are paced too. API and
metadata pacing remain separate. Pacing and connection waits are cancellable.`,
			Default:  fs.Duration(minSleep),
			Advanced: true,
		}, {
			Name: "use_https",
			Help: `Use HTTPS for transfers.

rfork uses HTTPS by default. Set false to diagnose HTTP transport behavior.
MEGA file contents are already encrypted, but some ISPs throttle HTTP.
HTTPS adds TLS processing and network overhead.`,
			Default:  true,
			Advanced: true,
		}, {
			Name:     config.ConfigEncoding,
			Help:     config.ConfigEncodingHelp,
			Advanced: true,
			// Encode invalid UTF-8 bytes as json doesn't handle them properly.
			Default: (encoder.Base |
				encoder.EncodeInvalidUtf8),
		}},
	})
}

// Options defines the configuration for this backend
type Options struct {
	User                  string               `config:"user"`
	Pass                  string               `config:"pass"`
	TwoFA                 string               `config:"2fa"`
	SessionID             string               `config:"session_id"`
	MasterKey             string               `config:"master_key"`
	Debug                 bool                 `config:"debug"`
	HardDelete            bool                 `config:"hard_delete"`
	UseHTTPS              bool                 `config:"use_https"`
	UploadConcurrency     int                  `config:"upload_concurrency"`
	UploadDiagnostics     bool                 `config:"upload_diagnostics"`
	UploadRetries         int                  `config:"upload_retries"`
	UploadRetryBodyErrors bool                 `config:"upload_retry_body_errors"`
	UploadPacing          fs.Duration          `config:"upload_pacing"`
	UploadRequestSize     fs.SizeSuffix        `config:"upload_request_size"`
	Enc                   encoder.MultiEncoder `config:"encoding"`
}

// Fs represents a remote mega
type Fs struct {
	name         string        // name of this remote
	root         string        // the path we are working on
	opt          Options       // parsed config options
	features     *fs.Features  // optional features
	srv          *mega.Mega    // the connection to the server
	pacer        *fs.Pacer     // pacer for API calls
	dataPacer    *uploadPacer  // shared by this backend's uploads
	requestSlots chan struct{} // foreground admission shared with API calls
	rootNodeMu   sync.Mutex    // mutex for _rootNode
	_rootNode    *mega.Node    // root node - call findRoot to use this
	mkdirMu      sync.Mutex    // used to serialize calls to mkdir / rmdir
}

type uploadPacer struct {
	interval time.Duration
	gate     chan struct{}
	next     time.Time // guarded by gate
}

func newUploadPacer(interval time.Duration) *uploadPacer {
	return &uploadPacer{interval: interval, gate: make(chan struct{}, 1)}
}

func (p *uploadPacer) wait(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.interval == 0 {
		return nil
	}
	select {
	case p.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-p.gate }()
	if delay := time.Until(p.next); delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p.next = time.Now().Add(p.interval)
	return nil
}

func (f *Fs) acquireRequest(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.requestSlots == nil {
		return func() {}, nil
	}
	select {
	case f.requestSlots <- struct{}{}:
		return func() { <-f.requestSlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (f *Fs) startDataRequest(ctx context.Context) (func(), error) {
	release, err := f.acquireRequest(ctx)
	if err != nil {
		return nil, err
	}
	if err := f.dataPacer.wait(ctx); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

func (f *Fs) call(ctx context.Context, fn pacer.Paced) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return f.pacer.Call(func() (bool, error) {
		release, err := f.acquireRequest(ctx)
		if err != nil {
			return false, err
		}
		defer release()
		return fn()
	})
}

// Object describes a mega object
//
// Will definitely have info but maybe not meta.
//
// Normally rclone would just store an ID here but go-mega and mega.nz
// expect you to build an entire tree of all the objects in memory.
// In this case we just store a pointer to the object.
type Object struct {
	fs     *Fs        // what this object is part of
	remote string     // The remote path
	info   *mega.Node // pointer to the mega node
}

// ------------------------------------------------------------

// Name of the remote (as passed into NewFs)
func (f *Fs) Name() string {
	return f.name
}

// Root of the remote (as passed into NewFs)
func (f *Fs) Root() string {
	return f.root
}

// String converts this Fs to a string
func (f *Fs) String() string {
	return fmt.Sprintf("mega root '%s'", f.root)
}

// Features returns the optional features of this Fs
func (f *Fs) Features() *fs.Features {
	return f.features
}

// parsePath parses a mega 'url'
func parsePath(path string) (root string) {
	root = strings.Trim(path, "/")
	return
}

// shouldRetry returns a boolean as to whether this err deserves to be
// retried.  It returns the err as a convenience
func shouldRetry(ctx context.Context, err error) (bool, error) {
	if fserrors.ContextError(ctx, &err) {
		return false, err
	}
	// Let the mega library handle the low level retries
	return false, err
}

// readMetaDataForPath reads the metadata from the path
func (f *Fs) readMetaDataForPath(ctx context.Context, remote string) (info *mega.Node, err error) {
	rootNode, err := f.findRoot(ctx, false)
	if err != nil {
		return nil, err
	}
	return f.findObject(rootNode, remote)
}

// NewFs constructs an Fs from the path, container:path
func NewFs(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
	// Parse config into Options struct
	opt := new(Options)
	err := configstruct.Set(m, opt)
	if err != nil {
		return nil, err
	}
	if opt.UploadConcurrency < 1 || opt.UploadConcurrency > 32 {
		return nil, errors.New("mega upload concurrency must be between 1 and 32")
	}
	if opt.UploadRetries < -1 {
		return nil, errors.New("mega upload retries must be -1 or nonnegative")
	}
	if opt.UploadPacing < 0 {
		return nil, errors.New("mega upload pacing must be nonnegative")
	}
	if err := validateUploadRequestSize(int64(opt.UploadRequestSize)); err != nil {
		return nil, err
	}
	if opt.Pass != "" {
		var err error
		opt.Pass, err = obscure.Reveal(opt.Pass)
		if err != nil {
			return nil, fmt.Errorf("couldn't decrypt password: %w", err)
		}
	}
	ci := fs.GetConfig(ctx)

	// Create Fs
	root = parsePath(root)
	f := &Fs{
		name:      name,
		root:      root,
		opt:       *opt,
		pacer:     fs.NewPacer(ctx, pacer.NewDefault(pacer.MinSleep(minSleep), pacer.MaxSleep(maxSleep), pacer.DecayConstant(decayConstant))),
		dataPacer: newUploadPacer(time.Duration(opt.UploadPacing)),
	}
	if ci.MaxConnections > 0 {
		f.requestSlots = make(chan struct{}, ci.MaxConnections)
	}
	f.features = (&fs.Features{
		DuplicateFiles:          true,
		CanHaveEmptyDirectories: true,
	}).Fill(ctx, f)

	// cache *mega.Mega on username so we can reuse and share
	// them between remotes.  They are expensive to make as they
	// contain all the objects and sharing the objects makes the
	// move code easier as we don't have to worry about mixing
	// them up between different remotes.
	megaCacheMu.Lock()
	defer megaCacheMu.Unlock()
	srv := megaCache[opt.User]
	if srv == nil {
		srv = mega.New().SetClient(fshttp.NewClient(ctx))
		srv.SetRetries(ci.LowLevelRetries) // let mega do the low level retries
		srv.SetHTTPS(opt.UseHTTPS)
		srv.SetLogger(func(format string, v ...any) {
			fs.Infof("*go-mega*", format, v...)
		})
		if opt.Debug {
			srv.SetDebugger(func(format string, v ...any) {
				fs.Debugf("*go-mega*", format, v...)
			})
		}

		if opt.SessionID == "" {
			fs.Debugf(f, "Using username and password to initialize the Mega API")
			err := srv.MultiFactorLogin(opt.User, opt.Pass, opt.TwoFA)
			if err != nil {
				return nil, fmt.Errorf("couldn't login: %w", err)
			}
			m.Set(sessionIDConfigKey, srv.GetSessionID())
			encodedMasterKey := base64.StdEncoding.EncodeToString(srv.GetMasterKey())
			m.Set(masterKeyConfigKey, encodedMasterKey)
		} else {
			fs.Debugf(f, "Using previously stored session ID and master key to initialize the Mega API")
			decodedMasterKey, err := base64.StdEncoding.DecodeString(opt.MasterKey)
			if err != nil {
				return nil, fmt.Errorf("couldn't decode master key: %w", err)
			}
			err = srv.LoginWithKeys(opt.SessionID, decodedMasterKey)
			if err != nil {
				return nil, fmt.Errorf("login with previous auth keys failed: %w", err)
			}
		}
		// Cache the session so all Fs instances of this user share
		// it - the move code relies on all objects being in the same
		// in-memory tree.
		megaCache[opt.User] = srv
	}
	f.srv = srv

	// Find the root node and check if it is a file or not
	_, err = f.findRoot(ctx, false)
	switch err {
	case nil:
		// root node found and is a directory
	case fs.ErrorDirNotFound:
		// root node not found, so can't be a file
	case fs.ErrorIsFile:
		// root node is a file so point to parent directory
		root = path.Dir(root)
		if root == "." {
			root = ""
		}
		f.root = root
		return f, err
	}
	return f, nil
}

// splitNodePath splits nodePath into / separated parts, returning nil if it
// should refer to the root.
// It also encodes the parts into backend-specific encoding
func (f *Fs) splitNodePath(nodePath string) (parts []string) {
	nodePath = path.Clean(nodePath)
	if nodePath == "." || nodePath == "/" {
		return nil
	}
	nodePath = f.opt.Enc.FromStandardPath(nodePath)
	return strings.Split(nodePath, "/")
}

// findNode looks up the node for the path of the name given from the root given
//
// It returns mega.ENOENT if it wasn't found
func (f *Fs) findNode(rootNode *mega.Node, nodePath string) (*mega.Node, error) {
	parts := f.splitNodePath(nodePath)
	if parts == nil {
		return rootNode, nil
	}
	nodes, err := f.srv.FS.PathLookup(rootNode, parts)
	if err != nil {
		return nil, err
	}
	return nodes[len(nodes)-1], nil
}

// findDir finds the directory rooted from the node passed in
func (f *Fs) findDir(rootNode *mega.Node, dir string) (node *mega.Node, err error) {
	node, err = f.findNode(rootNode, dir)
	if err == mega.ENOENT {
		return nil, fs.ErrorDirNotFound
	} else if err == nil && node.GetType() == mega.FILE {
		return nil, fs.ErrorIsFile
	}
	return node, err
}

// findObject looks up the node for the object of the name given
func (f *Fs) findObject(rootNode *mega.Node, file string) (node *mega.Node, err error) {
	node, err = f.findNode(rootNode, file)
	if err == mega.ENOENT {
		return nil, fs.ErrorObjectNotFound
	} else if err == nil && node.GetType() != mega.FILE {
		return nil, fs.ErrorIsDir // all other node types are directories
	}
	return node, err
}

// lookupDir looks up the node for the directory of the name given
//
// if create is true it tries to create the root directory if not found
func (f *Fs) lookupDir(ctx context.Context, dir string) (*mega.Node, error) {
	rootNode, err := f.findRoot(ctx, false)
	if err != nil {
		return nil, err
	}
	return f.findDir(rootNode, dir)
}

// lookupParentDir finds the parent node for the remote passed in
func (f *Fs) lookupParentDir(ctx context.Context, remote string) (dirNode *mega.Node, leaf string, err error) {
	parent, leaf := path.Split(remote)
	dirNode, err = f.lookupDir(ctx, parent)
	return dirNode, leaf, err
}

// mkdir makes the directory and any parent directories for the
// directory of the name given
func (f *Fs) mkdir(ctx context.Context, rootNode *mega.Node, dir string) (node *mega.Node, err error) {
	f.mkdirMu.Lock()
	defer f.mkdirMu.Unlock()

	parts := f.splitNodePath(dir)
	if parts == nil {
		return rootNode, nil
	}
	var i int
	// look up until we find a directory which exists
	for i = 0; i <= len(parts); i++ {
		var nodes []*mega.Node
		nodes, err = f.srv.FS.PathLookup(rootNode, parts[:len(parts)-i])
		if err == nil {
			if len(nodes) == 0 {
				node = rootNode
			} else {
				node = nodes[len(nodes)-1]
			}
			break
		}
		if err != mega.ENOENT {
			return nil, fmt.Errorf("mkdir lookup failed: %w", err)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("internal error: mkdir called with nonexistent root node: %w", err)
	}
	// i is number of directories to create (may be 0)
	// node is directory to create them from
	for _, name := range parts[len(parts)-i:] {
		// create directory called name in node
		err = f.call(ctx, func() (bool, error) {
			node, err = f.srv.CreateDir(name, node)
			return shouldRetry(ctx, err)
		})
		if err != nil {
			return nil, fmt.Errorf("mkdir create node failed: %w", err)
		}
	}
	return node, nil
}

// mkdirParent creates the parent directory of remote
func (f *Fs) mkdirParent(ctx context.Context, remote string) (dirNode *mega.Node, leaf string, err error) {
	rootNode, err := f.findRoot(ctx, true)
	if err != nil {
		return nil, "", err
	}
	parent, leaf := path.Split(remote)
	dirNode, err = f.mkdir(ctx, rootNode, parent)
	return dirNode, leaf, err
}

// findRoot looks up the root directory node and returns it.
//
// if create is true it tries to create the root directory if not found
func (f *Fs) findRoot(ctx context.Context, create bool) (*mega.Node, error) {
	f.rootNodeMu.Lock()
	defer f.rootNodeMu.Unlock()

	// Check if we haven't found it already
	if f._rootNode != nil {
		return f._rootNode, nil
	}

	// Check for preexisting root
	absRoot := f.srv.FS.GetRoot()
	node, err := f.findDir(absRoot, f.root)
	//log.Printf("findRoot findDir %p %v", node, err)
	if err == nil {
		f._rootNode = node
		return node, nil
	}
	if !create || err != fs.ErrorDirNotFound {
		return nil, err
	}

	//..not found so create the root directory
	f._rootNode, err = f.mkdir(ctx, absRoot, f.root)
	return f._rootNode, err
}

// clearRoot unsets the root directory
func (f *Fs) clearRoot() {
	f.rootNodeMu.Lock()
	f._rootNode = nil
	f.rootNodeMu.Unlock()
	//log.Printf("cleared root directory")
}

// CleanUp deletes all files currently in trash
func (f *Fs) CleanUp(ctx context.Context) (err error) {
	trash := f.srv.FS.GetTrash()
	items := []*mega.Node{}
	_, err = f.list(ctx, trash, func(item *mega.Node) bool {
		items = append(items, item)
		return false
	})
	if err != nil {
		return fmt.Errorf("CleanUp failed to list items in trash: %w", err)
	}
	fs.Infof(f, "Deleting %d items from the trash", len(items))
	errors := 0
	// similar to f.deleteNode(trash) but with HardDelete as true
	for _, item := range items {
		fs.Debugf(f, "Deleting trash %q", f.opt.Enc.ToStandardName(item.GetName()))
		deleteErr := f.call(ctx, func() (bool, error) {
			err := f.srv.Delete(item, true)
			return shouldRetry(ctx, err)
		})
		if deleteErr != nil {
			err = deleteErr
			errors++
		}
	}
	fs.Infof(f, "Deleted %d items from the trash with %d errors", len(items), errors)
	return err
}

// Return an Object from a path
//
// If it can't be found it returns the error fs.ErrorObjectNotFound.
func (f *Fs) newObjectWithInfo(ctx context.Context, remote string, info *mega.Node) (fs.Object, error) {
	o := &Object{
		fs:     f,
		remote: remote,
	}
	var err error
	if info != nil {
		// Set info
		err = o.setMetaData(info)
	} else {
		err = o.readMetaData(ctx) // reads info and meta, returning an error
	}
	if err != nil {
		return nil, err
	}
	return o, nil
}

// NewObject finds the Object at remote.  If it can't be found
// it returns the error fs.ErrorObjectNotFound.
func (f *Fs) NewObject(ctx context.Context, remote string) (fs.Object, error) {
	return f.newObjectWithInfo(ctx, remote, nil)
}

// list the objects into the function supplied
//
// If directories is set it only sends directories
// User function to process a File item from listAll
//
// Should return true to finish processing
type listFn func(*mega.Node) bool

// Lists the directory required calling the user function on each item found
//
// If the user fn ever returns true then it early exits with found = true
func (f *Fs) list(ctx context.Context, dir *mega.Node, fn listFn) (found bool, err error) {
	nodes, err := f.srv.FS.GetChildren(dir)
	if err != nil {
		return false, fmt.Errorf("list failed: %w", err)
	}
	if slices.ContainsFunc(nodes, fn) {
		found = true
	}
	return
}

// List the objects and directories in dir into entries.  The
// entries can be returned in any order but should be for a
// complete directory.
//
// dir should be "" to list the root, and should not have
// trailing slashes.
//
// This should return ErrDirNotFound if the directory isn't
// found.
func (f *Fs) List(ctx context.Context, dir string) (entries fs.DirEntries, err error) {
	dirNode, err := f.lookupDir(ctx, dir)
	if err != nil {
		return nil, err
	}
	var iErr error
	_, err = f.list(ctx, dirNode, func(info *mega.Node) bool {
		remote := path.Join(dir, f.opt.Enc.ToStandardName(info.GetName()))
		switch info.GetType() {
		case mega.FOLDER, mega.ROOT, mega.INBOX, mega.TRASH:
			d := fs.NewDir(remote, info.GetTimeStamp()).SetID(info.GetHash())
			entries = append(entries, d)
		case mega.FILE:
			o, err := f.newObjectWithInfo(ctx, remote, info)
			if err != nil {
				iErr = err
				return true
			}
			entries = append(entries, o)
		}
		return false
	})
	if err != nil {
		return nil, err
	}
	if iErr != nil {
		return nil, iErr
	}
	return entries, nil
}

// Creates from the parameters passed in a half finished Object which
// must have setMetaData called on it
//
// Returns the dirNode, object, leaf and error.
//
// Used to create new objects
func (f *Fs) createObject(ctx context.Context, remote string, modTime time.Time, size int64) (o *Object, dirNode *mega.Node, leaf string, err error) {
	dirNode, leaf, err = f.mkdirParent(ctx, remote)
	if err != nil {
		return nil, nil, leaf, err
	}
	// Temporary Object under construction
	o = &Object{
		fs:     f,
		remote: remote,
	}
	return o, dirNode, leaf, nil
}

// Put the object
//
// Copy the reader in to the new object which is returned.
//
// The new object may have been created if an error is returned
// PutUnchecked uploads the object
//
// This will create a duplicate if we upload a new file without
// checking to see if there is one already - use Put() for that.
func (f *Fs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	existingObj, err := f.newObjectWithInfo(ctx, src.Remote(), nil)
	switch err {
	case nil:
		return existingObj, existingObj.Update(ctx, in, src, options...)
	case fs.ErrorObjectNotFound:
		// Not found so create it
		return f.PutUnchecked(ctx, in, src)
	default:
		return nil, err
	}
}

// PutUnchecked the object
//
// Copy the reader in to the new object which is returned.
//
// The new object may have been created if an error is returned
// PutUnchecked uploads the object
//
// This will create a duplicate if we upload a new file without
// checking to see if there is one already - use Put() for that.
func (f *Fs) PutUnchecked(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	remote := src.Remote()
	size := src.Size()
	modTime := src.ModTime(ctx)

	o, _, _, err := f.createObject(ctx, remote, modTime, size)
	if err != nil {
		return nil, err
	}
	return o, o.Update(ctx, in, src, options...)
}

// Mkdir creates the directory if it doesn't exist
func (f *Fs) Mkdir(ctx context.Context, dir string) error {
	rootNode, err := f.findRoot(ctx, true)
	if err != nil {
		return err
	}
	_, err = f.mkdir(ctx, rootNode, dir)
	if err != nil {
		return fmt.Errorf("Mkdir failed: %w", err)
	}
	return nil
}

// deleteNode removes a file or directory, observing useTrash
func (f *Fs) deleteNode(ctx context.Context, node *mega.Node) (err error) {
	err = f.call(ctx, func() (bool, error) {
		err = f.srv.Delete(node, f.opt.HardDelete)
		return shouldRetry(ctx, err)
	})
	return err
}

// purgeCheck removes the directory dir, if check is set then it
// refuses to do so if it has anything in
func (f *Fs) purgeCheck(ctx context.Context, dir string, check bool) error {
	f.mkdirMu.Lock()
	defer f.mkdirMu.Unlock()

	rootNode, err := f.findRoot(ctx, false)
	if err != nil {
		return err
	}
	dirNode, err := f.findDir(rootNode, dir)
	if err != nil {
		return err
	}

	if check {
		children, err := f.srv.FS.GetChildren(dirNode)
		if err != nil {
			return fmt.Errorf("purgeCheck GetChildren failed: %w", err)
		}
		if len(children) > 0 {
			return fs.ErrorDirectoryNotEmpty
		}
	}

	waitEvent := f.srv.WaitEventsStart()

	err = f.deleteNode(ctx, dirNode)
	if err != nil {
		return fmt.Errorf("delete directory node failed: %w", err)
	}

	// Remove the root node if we just deleted it
	if dirNode == rootNode {
		f.clearRoot()
	}

	f.srv.WaitEvents(waitEvent, eventWaitTime)
	return nil
}

// Rmdir deletes the root folder
//
// Returns an error if it isn't empty
func (f *Fs) Rmdir(ctx context.Context, dir string) error {
	return f.purgeCheck(ctx, dir, true)
}

// Precision return the precision of this Fs
func (f *Fs) Precision() time.Duration {
	return fs.ModTimeNotSupported
}

// Purge deletes all the files in the directory
//
// Optional interface: Only implement this if you have a way of
// deleting all the files quicker than just running Remove() on the
// result of List()
func (f *Fs) Purge(ctx context.Context, dir string) error {
	return f.purgeCheck(ctx, dir, false)
}

// move a file or folder (srcFs, srcRemote, info) to (f, dstRemote)
//
// info will be updates
func (f *Fs) move(ctx context.Context, dstRemote string, srcFs *Fs, srcRemote string, info *mega.Node) (err error) {
	var (
		dstFs                  = f
		srcDirNode, dstDirNode *mega.Node
		srcParent, dstParent   string
		srcLeaf, dstLeaf       string
	)

	if dstRemote != "" {
		// lookup or create the destination parent directory
		dstDirNode, dstLeaf, err = dstFs.mkdirParent(ctx, dstRemote)
	} else {
		// find or create the parent of the root directory
		absRoot := dstFs.srv.FS.GetRoot()
		dstParent, dstLeaf = path.Split(dstFs.root)
		dstDirNode, err = dstFs.mkdir(ctx, absRoot, dstParent)
	}
	if err != nil {
		return fmt.Errorf("server-side move failed to make dst parent dir: %w", err)
	}

	if srcRemote != "" {
		// lookup the existing parent directory
		srcDirNode, srcLeaf, err = srcFs.lookupParentDir(ctx, srcRemote)
	} else {
		// lookup the existing root parent
		absRoot := srcFs.srv.FS.GetRoot()
		srcParent, srcLeaf = path.Split(srcFs.root)
		srcDirNode, err = f.findDir(absRoot, srcParent)
	}
	if err != nil {
		return fmt.Errorf("server-side move failed to lookup src parent dir: %w", err)
	}

	waitEvent := f.srv.WaitEventsStart()

	// move the object into its new directory if required
	if srcDirNode != dstDirNode && srcDirNode.GetHash() != dstDirNode.GetHash() {
		//log.Printf("move src %p %q dst %p %q", srcDirNode, srcDirNode.GetName(), dstDirNode, dstDirNode.GetName())
		err = f.call(ctx, func() (bool, error) {
			err = f.srv.Move(info, dstDirNode)
			return shouldRetry(ctx, err)
		})
		if err != nil {
			return fmt.Errorf("server-side move failed: %w", err)
		}
	}

	// rename the object if required
	if srcLeaf != dstLeaf {
		//log.Printf("rename %q to %q", srcLeaf, dstLeaf)
		err = f.call(ctx, func() (bool, error) {
			err = f.srv.Rename(info, f.opt.Enc.FromStandardName(dstLeaf))
			return shouldRetry(ctx, err)
		})
		if err != nil {
			return fmt.Errorf("server-side rename failed: %w", err)
		}
	}

	f.srv.WaitEvents(waitEvent, eventWaitTime)

	return nil
}

// Move src to this remote using server-side move operations.
//
// This is stored with the remote path given.
//
// It returns the destination Object and a possible error.
//
// Will only be called if src.Fs().Name() == f.Name()
//
// If it isn't possible then return fs.ErrorCantMove
func (f *Fs) Move(ctx context.Context, src fs.Object, remote string) (fs.Object, error) {
	dstFs := f

	//log.Printf("Move %q -> %q", src.Remote(), remote)
	srcObj, ok := src.(*Object)
	if !ok {
		fs.Debugf(src, "Can't move - not same remote type")
		return nil, fs.ErrorCantMove
	}

	// Do the move
	err := f.move(ctx, remote, srcObj.fs, srcObj.remote, srcObj.info)
	if err != nil {
		return nil, err
	}

	// Create a destination object
	dstObj := &Object{
		fs:     dstFs,
		remote: remote,
		info:   srcObj.info,
	}
	return dstObj, nil
}

// DirMove moves src, srcRemote to this remote at dstRemote
// using server-side move operations.
//
// Will only be called if src.Fs().Name() == f.Name()
//
// If it isn't possible then return fs.ErrorCantDirMove
//
// If destination exists then return fs.ErrorDirExists
func (f *Fs) DirMove(ctx context.Context, src fs.Fs, srcRemote, dstRemote string) error {
	dstFs := f
	srcFs, ok := src.(*Fs)
	if !ok {
		fs.Debugf(srcFs, "Can't move directory - not same remote type")
		return fs.ErrorCantDirMove
	}

	// find the source
	info, err := srcFs.lookupDir(ctx, srcRemote)
	if err != nil {
		return err
	}

	// check the destination doesn't exist
	_, err = dstFs.lookupDir(ctx, dstRemote)
	if err == nil {
		return fs.ErrorDirExists
	} else if err != fs.ErrorDirNotFound {
		return fmt.Errorf("DirMove error while checking dest directory: %w", err)
	}

	// Do the move
	err = f.move(ctx, dstRemote, srcFs, srcRemote, info)
	if err != nil {
		return err
	}

	// Clear src if it was the root
	if srcRemote == "" {
		srcFs.clearRoot()
	}

	return nil
}

// DirCacheFlush an optional interface to flush internal directory cache
func (f *Fs) DirCacheFlush() {
	// f.dirCache.ResetRoot()
	// FIXME Flush the mega somehow?
}

// Hashes returns the supported hash sets.
func (f *Fs) Hashes() hash.Set {
	return hash.Set(hash.None)
}

// PublicLink generates a public link to the remote path (usually readable by anyone)
func (f *Fs) PublicLink(ctx context.Context, remote string, expire fs.Duration, unlink bool) (link string, err error) {
	root, err := f.findRoot(ctx, false)
	if err != nil {
		return "", fmt.Errorf("PublicLink failed to find root node: %w", err)
	}
	node, err := f.findNode(root, remote)
	if err != nil {
		return "", fmt.Errorf("PublicLink failed to find path: %w", err)
	}
	link, err = f.srv.Link(node, true)
	if err != nil {
		return "", fmt.Errorf("PublicLink failed to create link: %w", err)
	}
	return link, nil
}

// MergeDirs merges the contents of all the directories passed
// in into the first one and rmdirs the other directories.
func (f *Fs) MergeDirs(ctx context.Context, dirs []fs.Directory) error {
	if len(dirs) < 2 {
		return nil
	}
	// find dst directory
	dstDir := dirs[0]
	dstDirNode := f.srv.FS.HashLookup(dstDir.ID())
	if dstDirNode == nil {
		return fmt.Errorf("MergeDirs failed to find node for: %v", dstDir)
	}
	for _, srcDir := range dirs[1:] {
		// find src directory
		srcDirNode := f.srv.FS.HashLookup(srcDir.ID())
		if srcDirNode == nil {
			return fmt.Errorf("MergeDirs failed to find node for: %v", srcDir)
		}

		// list the objects
		infos := []*mega.Node{}
		_, err := f.list(ctx, srcDirNode, func(info *mega.Node) bool {
			infos = append(infos, info)
			return false
		})
		if err != nil {
			return fmt.Errorf("MergeDirs list failed on %v: %w", srcDir, err)
		}
		// move them into place
		for _, info := range infos {
			fs.Infof(srcDir, "merging %q", f.opt.Enc.ToStandardName(info.GetName()))
			err = f.call(ctx, func() (bool, error) {
				err = f.srv.Move(info, dstDirNode)
				return shouldRetry(ctx, err)
			})
			if err != nil {
				return fmt.Errorf("MergeDirs move failed on %q in %v: %w", f.opt.Enc.ToStandardName(info.GetName()), srcDir, err)
			}
		}
		// rmdir (into trash) the now empty source directory
		fs.Infof(srcDir, "removing empty directory")
		err = f.deleteNode(ctx, srcDirNode)
		if err != nil {
			return fmt.Errorf("MergeDirs move failed to rmdir %q: %w", srcDir, err)
		}
	}
	return nil
}

// About gets quota information
func (f *Fs) About(ctx context.Context) (*fs.Usage, error) {
	var q mega.QuotaResp
	var err error
	err = f.call(ctx, func() (bool, error) {
		q, err = f.srv.GetQuota()
		return shouldRetry(ctx, err)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get Mega Quota: %w", err)
	}
	usage := &fs.Usage{
		Total: fs.NewUsageValue(q.Mstrg),           // quota of bytes that can be used
		Used:  fs.NewUsageValue(q.Cstrg),           // bytes in use
		Free:  fs.NewUsageValue(q.Mstrg - q.Cstrg), // bytes which can be uploaded before reaching the quota
	}
	return usage, nil
}

// ------------------------------------------------------------

// Fs returns the parent Fs
func (o *Object) Fs() fs.Info {
	return o.fs
}

// Return a string version
func (o *Object) String() string {
	if o == nil {
		return "<nil>"
	}
	return o.remote
}

// Remote returns the remote path
func (o *Object) Remote() string {
	return o.remote
}

// Hash returns the hashes of an object
func (o *Object) Hash(ctx context.Context, t hash.Type) (string, error) {
	return "", hash.ErrUnsupported
}

// Size returns the size of an object in bytes
func (o *Object) Size() int64 {
	return o.info.GetSize()
}

// setMetaData sets the metadata from info
func (o *Object) setMetaData(info *mega.Node) (err error) {
	if info.GetType() != mega.FILE {
		return fs.ErrorIsDir // all other node types are directories
	}
	o.info = info
	return nil
}

// readMetaData gets the metadata if it hasn't already been fetched
//
// it also sets the info
func (o *Object) readMetaData(ctx context.Context) (err error) {
	if o.info != nil {
		return nil
	}
	info, err := o.fs.readMetaDataForPath(ctx, o.remote)
	if err != nil {
		if err == fs.ErrorDirNotFound {
			err = fs.ErrorObjectNotFound
		}
		return err
	}
	return o.setMetaData(info)
}

// ModTime returns the modification time of the object
//
// It attempts to read the objects mtime and if that isn't present the
// LastModified returned in the http headers
func (o *Object) ModTime(ctx context.Context) time.Time {
	return o.info.GetTimeStamp()
}

// SetModTime sets the modification time of the local fs object
func (o *Object) SetModTime(ctx context.Context, modTime time.Time) error {
	return fs.ErrorCantSetModTime
}

// Storable returns a boolean showing whether this object storable
func (o *Object) Storable() bool {
	return true
}

// openObject represents a download in progress
type openObject struct {
	ctx    context.Context
	mu     sync.Mutex
	o      *Object
	d      *mega.Download
	id     int
	skip   int64
	chunk  []byte
	closed bool
}

// get the next chunk
func (oo *openObject) getChunk(ctx context.Context) (err error) {
	if oo.id >= oo.d.Chunks() {
		return io.EOF
	}
	var chunk []byte
	err = oo.o.fs.call(ctx, func() (bool, error) {
		chunk, err = oo.d.DownloadChunk(oo.id)
		return shouldRetry(ctx, err)
	})
	if err != nil {
		return err
	}
	oo.id++
	oo.chunk = chunk
	return nil
}

// Read reads up to len(p) bytes into p.
func (oo *openObject) Read(p []byte) (n int, err error) {
	oo.mu.Lock()
	defer oo.mu.Unlock()
	if oo.closed {
		return 0, errors.New("read on closed file")
	}
	// Skip data at the start if requested
	for oo.skip > 0 {
		_, size, err := oo.d.ChunkLocation(oo.id)
		if err != nil {
			return 0, err
		}
		if oo.skip < int64(size) {
			break
		}
		oo.id++
		oo.skip -= int64(size)
	}
	if len(oo.chunk) == 0 {
		err = oo.getChunk(oo.ctx)
		if err != nil {
			return 0, err
		}
		if oo.skip > 0 {
			oo.chunk = oo.chunk[oo.skip:]
			oo.skip = 0
		}
	}
	n = copy(p, oo.chunk)
	oo.chunk = oo.chunk[n:]
	return n, nil
}

// Close closed the file - MAC errors are reported here
func (oo *openObject) Close() (err error) {
	oo.mu.Lock()
	defer oo.mu.Unlock()
	if oo.closed {
		return nil
	}
	err = oo.o.fs.call(oo.ctx, func() (bool, error) {
		err = oo.d.Finish()
		return shouldRetry(oo.ctx, err)
	})
	if err != nil {
		return fmt.Errorf("failed to finish download: %w", err)
	}
	oo.closed = true
	return nil
}

// Open an object for read
func (o *Object) Open(ctx context.Context, options ...fs.OpenOption) (in io.ReadCloser, err error) {
	var offset, limit int64 = 0, -1
	for _, option := range options {
		switch x := option.(type) {
		case *fs.SeekOption:
			offset = x.Offset
		case *fs.RangeOption:
			offset, limit = x.Decode(o.Size())
		default:
			if option.Mandatory() {
				fs.Logf(o, "Unsupported mandatory option: %v", option)
			}
		}
	}

	var d *mega.Download
	err = o.fs.call(ctx, func() (bool, error) {
		d, err = o.fs.srv.NewDownload(o.info)
		return shouldRetry(ctx, err)
	})
	if err != nil {
		return nil, fmt.Errorf("open download file failed: %w", err)
	}

	oo := &openObject{
		ctx:  ctx,
		o:    o,
		d:    d,
		skip: offset,
	}

	return readers.NewLimitedReadCloser(oo, limit), nil
}

// uploadSession retains one server-side upload until all chunks have succeeded.
type uploadSession interface {
	Chunks() int
	ChunkLocation(int) (int64, int, error)
	UploadChunkContext(context.Context, int, []byte) error
	FinishContext(context.Context) (*mega.Node, error)
}

type batchUploadSession interface {
	uploadSession
	UploadRangeContext(context.Context, int, int, []byte) error
}

type pacedUpload struct {
	*mega.Upload
	fs           *Fs
	beforeFinish func()
	afterFinish  func()
}

func (u pacedUpload) FinishContext(ctx context.Context) (node *mega.Node, err error) {
	err = u.fs.call(ctx, func() (bool, error) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if u.beforeFinish != nil {
			u.beforeFinish()
		}
		node, err = u.Upload.FinishContext(ctx)
		if u.afterFinish != nil {
			u.afterFinish()
		}
		return false, err
	})
	return node, err
}

type uploadReport struct {
	SchemaVersion    int                    `json:"schemaVersion"`
	Workers          int                    `json:"workers"`
	RetryLimit       int                    `json:"retryLimit"`
	RetryBodyErrors  bool                   `json:"retryBodyErrors"`
	PacingSeconds    float64                `json:"pacingSeconds"`
	RequestSizeBytes int64                  `json:"requestSizeBytes"`
	HTTPS            bool                   `json:"https"`
	SourceBytes      int64                  `json:"sourceBytes"`
	SourceRead       mega.UploadTiming      `json:"sourceRead"`
	SetupSeconds     float64                `json:"setupSeconds"`
	DataSeconds      float64                `json:"dataSeconds"`
	CommitSeconds    float64                `json:"commitSeconds"`
	ElapsedSeconds   float64                `json:"elapsedSeconds"`
	Committed        bool                   `json:"committed"`
	Successful       bool                   `json:"successful"`
	Chunks           mega.UploadDiagnostics `json:"chunks"`
}

type uploadDiagnosticReader struct {
	io.Reader
	report *uploadReport
}

func (r uploadDiagnosticReader) Read(b []byte) (int, error) {
	started := time.Now()
	n, err := r.Reader.Read(b)
	seconds := time.Since(started).Seconds()
	r.report.SourceBytes += int64(n)
	timing := &r.report.SourceRead
	if timing.Count == 0 || seconds < timing.MinSeconds {
		timing.MinSeconds = seconds
	}
	timing.Count++
	timing.Seconds += seconds
	timing.MaxSeconds = max(timing.MaxSeconds, seconds)
	return n, err
}

// uploadAndFinish joins all workers before committing or returning an error.
// The input is read serially; only owned chunk buffers cross goroutines.
func uploadAndFinish(ctx context.Context, in io.Reader, u uploadSession, concurrency int) (*mega.Node, error) {
	return uploadAndFinishSized(ctx, in, u, concurrency, 0)
}

func validateUploadRequestSize(size int64) error {
	if size < 0 || size > maxUploadRequestSize || (size > 0 && size < 1024*1024) {
		return errors.New("mega upload request size must be 0 or between 1 MiB and 64 MiB")
	}
	return nil
}

func planUploadRange(u uploadSession, first int, limit int64) (count, size int, err error) {
	var expected int64
	for id := first; id < u.Chunks(); id++ {
		position, n, err := u.ChunkLocation(id)
		if err != nil {
			return 0, 0, fmt.Errorf("chunk %d location: %w", id, err)
		}
		if n < 0 || n > 1024*1024 || position < 0 {
			return 0, 0, fmt.Errorf("invalid native chunk %d layout", id)
		}
		if count > 0 && (limit == 0 || int64(size)+int64(n) > limit) {
			break
		}
		if count > 0 && position != expected {
			return 0, 0, errors.New("noncontiguous native chunks in upload request")
		}
		count++
		size += n
		expected = position + int64(n)
		if limit == 0 {
			break
		}
	}
	if count == 0 {
		return 0, 0, errors.New("empty upload range")
	}
	return count, size, nil
}

// uploadAndFinishSized groups native chunks into bounded request jobs when enabled.
func uploadAndFinishSized(ctx context.Context, in io.Reader, u uploadSession, concurrency int, requestSize int64) (*mega.Node, error) {
	if concurrency < 1 || concurrency > 32 {
		return nil, errors.New("mega upload concurrency must be between 1 and 32")
	}
	if err := validateUploadRequestSize(requestSize); err != nil {
		return nil, err
	}
	var batches batchUploadSession
	if requestSize > 0 {
		var ok bool
		batches, ok = u.(batchUploadSession)
		if !ok {
			return nil, errors.New("upload session does not support request batching")
		}
	}
	parent := ctx
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	group, workerCtx := errgroup.WithContext(ctx)
	type chunkJob struct {
		id    int
		count int
		data  []byte
	}
	jobs := make(chan chunkJob)
	for range concurrency {
		group.Go(func() error {
			for {
				select {
				case <-workerCtx.Done():
					return workerCtx.Err()
				case job, ok := <-jobs:
					if !ok {
						return nil
					}
					if err := workerCtx.Err(); err != nil {
						return err
					}
					var err error
					if job.count > 1 {
						err = batches.UploadRangeContext(workerCtx, job.id, job.count, job.data)
					} else {
						err = u.UploadChunkContext(workerCtx, job.id, job.data)
					}
					if err != nil {
						return err
					}
				}
			}
		})
	}
	readErr := func() error {
		for id := 0; id < u.Chunks(); {
			if err := workerCtx.Err(); err != nil {
				return err
			}
			count, size, err := planUploadRange(u, id, requestSize)
			if err != nil {
				return err
			}
			chunk := make([]byte, size)
			if _, err := io.ReadFull(in, chunk); err != nil {
				return fmt.Errorf("chunk %d source: %w", id, err)
			}
			select {
			case jobs <- chunkJob{id: id, count: count, data: chunk}:
			case <-workerCtx.Done():
				return workerCtx.Err()
			}
			id += count
		}
		return nil
	}()
	close(jobs)
	if readErr != nil {
		cancel()
	}
	workerErr := group.Wait()
	if workerErr != nil && !errors.Is(workerErr, context.Canceled) {
		return nil, workerErr
	}
	if readErr != nil {
		return nil, readErr
	}
	if workerErr != nil {
		return nil, workerErr
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	node, err := u.FinishContext(parent)
	if err != nil {
		// A commit may have reached MEGA even if its response never arrived.
		return nil, fserrors.NoRetryError(fmt.Errorf("MEGA finalization failed; remote outcome may be uncertain, inspect before retrying: %w", err))
	}
	return node, nil
}

// Update the object with the contents of the io.Reader, modTime and size
//
// If existing is set then it updates the object rather than creating a new one.
//
// The new object may have been created if an error is returned
func (o *Object) Update(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (err error) {
	var u *mega.Upload
	var report *uploadReport
	var started, dataStarted, commitStarted time.Time
	if o.fs.opt.UploadDiagnostics {
		started = time.Now()
		report = &uploadReport{SchemaVersion: 1, Workers: o.fs.opt.UploadConcurrency, HTTPS: o.fs.opt.UseHTTPS}
		in = uploadDiagnosticReader{Reader: in, report: report}
		defer func() {
			if u != nil {
				report.Chunks = u.Diagnostics()
			}
			report.ElapsedSeconds = time.Since(started).Seconds()
			report.Successful = err == nil
			fs.LogPrintf(fs.LogLevelNotice, nil, "MEGA upload diagnostics: %s", fs.LogValue("megaUpload", report))
		}()
	}
	size := src.Size()
	if size < 0 {
		return errors.New("mega backend can't upload a file of unknown length")
	}
	//modTime := src.ModTime(ctx)
	remote := o.Remote()

	// Create the parent directory
	dirNode, leaf, err := o.fs.mkdirParent(ctx, remote)
	if err != nil {
		return fmt.Errorf("update make parent dir failed: %w", err)
	}

	err = o.fs.call(ctx, func() (bool, error) {
		u, err = o.fs.srv.NewUploadContext(ctx, dirNode, o.fs.opt.Enc.FromStandardName(leaf), size, o.fs.opt.UseHTTPS)
		return shouldRetry(ctx, err)
	})
	if err != nil {
		return fmt.Errorf("upload file failed to create session: %w", err)
	}
	if report != nil {
		u.EnableDiagnostics()
		report.SetupSeconds = time.Since(started).Seconds()
		dataStarted = time.Now()
	}
	retries := o.fs.opt.UploadRetries
	if retries < 0 {
		retries = fs.GetConfig(ctx).LowLevelRetries
	}
	if err := u.SetUploadRetryOptions(retries, o.fs.opt.UploadRetryBodyErrors); err != nil {
		return err
	}
	u.SetUploadRequestHook(o.fs.startDataRequest)
	if report != nil {
		report.RetryLimit = retries
		report.RetryBodyErrors = o.fs.opt.UploadRetryBodyErrors
		report.PacingSeconds = time.Duration(o.fs.opt.UploadPacing).Seconds()
		report.RequestSizeBytes = int64(o.fs.opt.UploadRequestSize)
	}

	var waitEvent <-chan struct{}
	info, err := uploadAndFinishSized(ctx, in, pacedUpload{Upload: u, fs: o.fs,
		beforeFinish: func() {
			if report != nil {
				report.DataSeconds = time.Since(dataStarted).Seconds()
				commitStarted = time.Now()
			}
			waitEvent = o.fs.srv.WaitEventsStart()
		},
		afterFinish: func() {
			if report != nil {
				report.CommitSeconds = time.Since(commitStarted).Seconds()
			}
		},
	}, o.fs.opt.UploadConcurrency, int64(o.fs.opt.UploadRequestSize))
	if report != nil && commitStarted.IsZero() {
		report.DataSeconds = time.Since(dataStarted).Seconds()
	}
	if err != nil {
		return err
	}
	if report != nil {
		report.Committed = true
	}

	// If the upload succeeded and the original object existed, then delete it
	if o.info != nil {
		err = o.fs.deleteNode(ctx, o.info)
		if err != nil {
			return fmt.Errorf("upload failed to remove old version: %w", err)
		}
		o.info = nil
	}

	// Wait for the server to confirm the new file
	o.fs.srv.WaitEvents(waitEvent, eventWaitTime)

	return o.setMetaData(info)
}

// Remove an object
func (o *Object) Remove(ctx context.Context) error {
	waitEvent := o.fs.srv.WaitEventsStart()

	err := o.fs.deleteNode(ctx, o.info)
	if err != nil {
		return fmt.Errorf("Remove object failed: %w", err)
	}

	// Wait for the server to confirm the deletion
	o.fs.srv.WaitEvents(waitEvent, eventWaitTime)
	return nil
}

// ID returns the ID of the Object if known, or "" if not
func (o *Object) ID() string {
	return o.info.GetHash()
}

// Check the interfaces are satisfied
var (
	_ fs.Fs              = (*Fs)(nil)
	_ fs.Purger          = (*Fs)(nil)
	_ fs.Mover           = (*Fs)(nil)
	_ fs.PutUncheckeder  = (*Fs)(nil)
	_ fs.DirMover        = (*Fs)(nil)
	_ fs.DirCacheFlusher = (*Fs)(nil)
	_ fs.PublicLinker    = (*Fs)(nil)
	_ fs.MergeDirser     = (*Fs)(nil)
	_ fs.Abouter         = (*Fs)(nil)
	_ fs.Object          = (*Object)(nil)
	_ fs.IDer            = (*Object)(nil)
)
