package mega

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/fserrors"
	"github.com/rclone/rclone/lib/pacer"
	"github.com/stretchr/testify/require"
	megaclient "github.com/t3rm1n4l/go-mega"
)

// TestUploadResumeLocalProcess runs only as the dedicated child of the TLS
// fixture. Process exit also retires the dependency's unbounded event poller.
func TestUploadResumeLocalProcess(t *testing.T) {
	if os.Getenv("RFORK_RESUME_FIXTURE") != "1" {
		t.Skip("local process fixture child only")
	}
	endpoint := os.Getenv("RFORK_RESUME_FIXTURE_URL")
	require.True(t, strings.HasPrefix(endpoint, "https://127.0.0.1:"))
	cert, err := base64.StdEncoding.DecodeString(os.Getenv("RFORK_RESUME_FIXTURE_CERT"))
	require.NoError(t, err)
	certificate, err := x509.ParseCertificate(cert)
	require.NoError(t, err)
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	m := megaclient.New().SetClient(&http.Client{Transport: transport, Timeout: 5 * time.Second}).SetLogger(nil)
	m.SetAPIUrl(endpoint)
	m.SetRetries(0)
	require.NoError(t, m.LoginWithKeys("local-fixture-session", make([]byte, 16)))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	mode := os.Getenv("RFORK_RESUME_FIXTURE_MODE")
	if mode == "kill" || mode == "signal" {
		// Observe only public codec output. Readiness does not bypass the store
		// lock or alter the transfer's checkpoint/writer state.
		plain, err := os.ReadFile(os.Getenv("RFORK_RESUME_FIXTURE_SOURCE"))
		require.NoError(t, err)
		binding := megaclient.UploadCheckpointBinding{Account: "fixture-user", Parent: "root", Name: os.Getenv("RFORK_RESUME_FIXTURE_NAME"), Size: int64(len(plain)), SHA256: sha256.Sum256(plain)}
		go func() {
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					blob, err := os.ReadFile(filepath.Join(os.Getenv("RFORK_RESUME_FIXTURE_STATE"), "state"))
					if err != nil {
						continue
					}
					_, info, err := m.OpenUploadCheckpoint(blob, binding)
					if err == nil && info.Phase == megaclient.CheckpointUploading && info.AcknowledgedBytes >= 128<<10 {
						_ = os.WriteFile(os.Getenv("RFORK_RESUME_FIXTURE_READY"), []byte("ready"), 0600)
						return
					}
				}
			}
		}()
	}
	f := &Fs{srv: m, name: "fixture", features: &fs.Features{}, pacer: fs.NewPacer(ctx, pacer.NewDefault()), dataPacer: newUploadPacer(0), opt: Options{UseHTTPS: true, UploadConcurrency: 1, UploadRetries: 0}}
	result, commandErr := f.Command(ctx, "upload-resume", []string{os.Getenv("RFORK_RESUME_FIXTURE_SOURCE")}, map[string]string{
		"name": os.Getenv("RFORK_RESUME_FIXTURE_NAME"), "checkpoint": os.Getenv("RFORK_RESUME_FIXTURE_STATE"), "checkpoint-interval": "0",
	})
	if mode == "signal" {
		// Let the signal handler finish its cleanup and exit after Command joins.
		select {}
	}
	if mode == "failure" {
		require.Error(t, commandErr)
		return
	}
	if mode == "uncertain" {
		require.ErrorContains(t, commandErr, "uncertain")
		require.True(t, fserrors.IsNoRetryError(commandErr))
		require.False(t, fserrors.ShouldRetry(commandErr), "CLI must not turn a transient lost commit body into retry exit 5")
		return
	}
	require.NoError(t, commandErr)
	out, ok := result.(*resumeResult)
	require.True(t, ok)
	require.Equal(t, mode, out.Status)
	if mode == "committed" {
		require.Equal(t, int64(128<<10), out.RestoredAcknowledgedBytes)
	}
}

type resumeProtocolSession struct {
	size int64
	data map[int64][]byte
}

func TestUploadResumeLocalFreshProcesses(t *testing.T) {
	plain := make([]byte, 2<<20+31)
	for i := range plain {
		plain[i] = byte(i*23 + 7)
	}
	source := filepath.Join(t.TempDir(), "source.bin")
	require.NoError(t, os.WriteFile(source, plain, 0600))
	state := filepath.Join(t.TempDir(), "state")
	var mu sync.Mutex
	sessions := map[string]*resumeProtocolSession{}
	var nodes []megaclient.FSNode
	var dataRequests []int64
	var commits int
	interrupt, loseCommit, blockAfterPrefix := true, false, false
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sc" {
			_ = json.NewEncoder(w).Encode(map[string]any{"w": server.URL + "/wait"})
			return
		}
		if r.URL.Path == "/wait" {
			select {
			case <-r.Context().Done():
			case <-time.After(20 * time.Millisecond):
			}
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/cs" {
			var message []map[string]json.RawMessage
			if json.NewDecoder(r.Body).Decode(&message) != nil || len(message) != 1 {
				http.Error(w, "bad fixture request", 400)
				return
			}
			var command string
			_ = json.Unmarshal(message[0]["a"], &command)
			switch command {
			case "f":
				root := megaclient.FSNode{Hash: "root", T: megaclient.ROOT}
				_ = json.NewEncoder(w).Encode([]map[string]any{{"f": append([]megaclient.FSNode{root}, nodes...), "sn": "fixture"}})
			case "ug":
				_ = json.NewEncoder(w).Encode([]map[string]string{{"u": "fixture-user"}})
			case "u":
				var size int64
				_ = json.Unmarshal(message[0]["s"], &size)
				id := strconv.Itoa(len(sessions) + 1)
				sessions[id] = &resumeProtocolSession{size: size, data: map[int64][]byte{}}
				_ = json.NewEncoder(w).Encode([]map[string]string{{"p": server.URL + "/upload/" + id}})
			case "p":
				commits++
				var msg [1]megaclient.UploadCompleteMsg
				encoded, _ := json.Marshal(message)
				_ = json.Unmarshal(encoded, &msg)
				node := megaclient.FSNode{Hash: fmt.Sprintf("node-%d", commits), Parent: "root", T: megaclient.FILE, User: "fixture-user", Key: "fixture-user:" + msg[0].N[0].K, Attr: msg[0].N[0].A, Sz: int64(len(plain))}
				nodes = append(nodes, node)
				if loseCommit {
					w.Header().Set("Content-Length", "100")
					_, _ = io.WriteString(w, "[")
					return
				}
				_ = json.NewEncoder(w).Encode([]megaclient.UploadCompleteResp{{F: []megaclient.FSNode{node}}})
			default:
				http.Error(w, "unexpected fixture API", 400)
			}
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if len(parts) != 3 || parts[0] != "upload" {
			http.NotFound(w, r)
			return
		}
		session := sessions[parts[1]]
		if session == nil {
			http.NotFound(w, r)
			return
		}
		offset, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			http.Error(w, "bad offset", 400)
			return
		}
		b, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "bad body", 400)
			return
		}
		dataRequests = append(dataRequests, offset)
		if blockAfterPrefix && offset != 0 {
			mu.Unlock()
			select {
			case <-r.Context().Done():
			case <-time.After(20 * time.Second):
			}
			mu.Lock()
			return
		}
		if interrupt && offset != 0 {
			_, _ = io.WriteString(w, "-3")
			return
		}
		session.data[offset] = b
		var received int64
		for _, data := range session.data {
			received += int64(len(data))
		}
		if received == session.size {
			_, _ = io.WriteString(w, "fixture-completion")
		}
	}))
	defer server.Close()
	executable, err := os.Executable()
	require.NoError(t, err)
	child := func(mode, name, directory string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, executable, "-test.run=^TestUploadResumeLocalProcess$", "-test.count=1")
		var env []string
		for _, item := range os.Environ() {
			if !strings.HasPrefix(item, "RFORK_RESUME_FIXTURE") {
				env = append(env, item)
			}
		}
		ready := filepath.Join(t.TempDir(), "ready")
		command.Env = append(env, "RFORK_RESUME_FIXTURE=1", "RFORK_RESUME_FIXTURE_URL="+server.URL, "RFORK_RESUME_FIXTURE_CERT="+base64.StdEncoding.EncodeToString(server.Certificate().Raw),
			"RFORK_RESUME_FIXTURE_READY="+ready,
			"RFORK_RESUME_FIXTURE_SOURCE="+source, "RFORK_RESUME_FIXTURE_STATE="+directory, "RFORK_RESUME_FIXTURE_NAME="+name, "RFORK_RESUME_FIXTURE_MODE="+mode)
		if mode == "kill" || mode == "signal" {
			var output bytes.Buffer
			command.Stdout, command.Stderr = &output, &output
			require.NoError(t, command.Start())
			defer func() { _ = command.Process.Kill() }()
			require.Eventually(t, func() bool { _, err := os.Stat(ready); return err == nil }, 10*time.Second, 5*time.Millisecond, "checkpoint prefix was not saved")
			if mode == "kill" {
				require.NoError(t, command.Process.Kill())
			} else {
				require.NoError(t, command.Process.Signal(os.Interrupt))
			}
			err := command.Wait()
			require.Error(t, err, "child survived termination: %s", output.String())
			require.NoError(t, ctx.Err(), "child failed to join before signal exit: %s", output.String())
			return
		}
		output, err := command.CombinedOutput()
		require.NoError(t, err, "child: %s", output)
	}
	child("failure", "file.bin", state)
	mu.Lock()
	require.Len(t, sessions, 1)
	require.Zero(t, commits)
	interrupt = false
	dataRequests = nil
	mu.Unlock()
	child("committed", "file.bin", state)
	mu.Lock()
	require.Len(t, sessions, 1)
	require.Equal(t, 1, commits)
	for _, offset := range dataRequests {
		require.NotZero(t, offset, "acknowledged prefix was retransmitted")
	}
	require.Len(t, nodes, 1)
	// Recover the actual file key independently from the encrypted commit payload.
	wrapped, err := base64.RawURLEncoding.DecodeString(strings.SplitN(nodes[0].Key, ":", 2)[1])
	require.NoError(t, err)
	master, _ := aes.NewCipher(make([]byte, 16))
	for off := 0; off < len(wrapped); off += 16 {
		cipher.NewCBCDecrypter(master, make([]byte, 16)).CryptBlocks(wrapped[off:off+16], wrapped[off:off+16])
	}
	key := make([]byte, 16)
	for i := range key {
		key[i] = wrapped[i] ^ wrapped[i+16]
	}
	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	decoded := make([]byte, len(plain))
	for offset, data := range sessions["1"].data {
		iv := make([]byte, 16)
		copy(iv, wrapped[16:24])
		binary.BigEndian.PutUint64(iv[8:], uint64(offset/16))
		cipher.NewCTR(block, iv).XORKeyStream(decoded[offset:offset+int64(len(data))], data)
	}
	require.Equal(t, sha256.Sum256(plain), sha256.Sum256(decoded))
	previousRequests := len(dataRequests)
	mu.Unlock()
	child("already-committed", "file.bin", state)
	mu.Lock()
	require.Len(t, sessions, 1)
	require.Equal(t, 1, commits)
	require.Len(t, dataRequests, previousRequests)
	mu.Unlock()
	for _, termination := range []string{"kill", "signal"} {
		if termination == "signal" && runtime.GOOS == "windows" {
			continue
		}
		crashState := filepath.Join(t.TempDir(), "state")
		mu.Lock()
		blockAfterPrefix = true
		mu.Unlock()
		child(termination, termination+".bin", crashState)
		mu.Lock()
		blockAfterPrefix = false
		dataRequests = nil
		mu.Unlock()
		child("committed", termination+".bin", crashState)
		mu.Lock()
		for _, offset := range dataRequests {
			require.NotZero(t, offset, "saved prefix replayed after process termination")
		}
		mu.Unlock()
	}
	mu.Lock()
	previousSessions, previousCommits := len(sessions), commits
	mu.Unlock()
	// A confirmed provider commit with a lost reply leaves intent, never a new API call.
	uncertainState := filepath.Join(t.TempDir(), "state")
	mu.Lock()
	loseCommit = true
	mu.Unlock()
	child("uncertain", "uncertain.bin", uncertainState)
	mu.Lock()
	require.Len(t, sessions, previousSessions+1)
	require.Equal(t, previousCommits+1, commits)
	previousRequests = len(dataRequests)
	mu.Unlock()
	child("uncertain", "uncertain.bin", uncertainState)
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, sessions, previousSessions+1)
	require.Equal(t, previousCommits+1, commits)
	require.Len(t, dataRequests, previousRequests)
	// Checkpoints contain opaque ciphertext, not destination or source plaintext.
	checkpoint, err := os.ReadFile(filepath.Join(state, "state"))
	require.NoError(t, err)
	require.False(t, bytes.Contains(checkpoint, []byte("file.bin")))
}
