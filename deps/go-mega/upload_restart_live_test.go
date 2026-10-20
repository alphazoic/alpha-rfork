package mega

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func restartProbePlaintext() []byte {
	plain := make([]byte, 9*1024*1024+31)
	for i := range plain {
		plain[i] = byte(i*29 + 17)
	}
	return plain
}

type restartProbeTransport struct {
	base   http.RoundTripper
	mu     sync.Mutex
	target string
	lost   bool
}

func (p *restartProbeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rsp, err := p.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	lose := req.URL.String() == p.target && !p.lost && rsp.StatusCode == http.StatusOK
	if lose {
		p.lost = true
	}
	p.mu.Unlock()
	if lose {
		body, readErr := io.ReadAll(io.LimitReader(rsp.Body, maxUploadResponseBytes+1))
		closeErr := rsp.Body.Close()
		if readErr != nil || closeErr != nil || len(body) == 0 || len(body) > maxUploadResponseBytes {
			return nil, errors.New("terminal-response fault could not be established")
		}
		rsp.Body = io.NopCloser(restartProbeLostBody{})
	}
	return rsp, nil
}

type restartProbeLostBody struct{}

func (restartProbeLostBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestLiveUploadRestartProtocol(t *testing.T) {
	if os.Getenv("RFORK_LIVE_RESTART") != "1" || runtime.GOOS != "linux" || flag.Lookup("test.run").Value.String() != "^TestLiveUploadRestartProtocol$" {
		t.Skip("manual Linux dedicated-account restart protocol probe only")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	if phase := os.Getenv("RFORK_RESTART_PHASE"); phase != "" {
		runRestartProbeWorker(ctx, t, phase)
		return
	}
	folder, reportPath, stock := os.Getenv("RFORK_PROTOCOL_FOLDER"), os.Getenv("RFORK_PROTOCOL_REPORT"), os.Getenv("RFORK_PROTOCOL_STOCK")
	if !regexp.MustCompile(`^rfork-protocol-[a-f0-9]{32}$`).MatchString(folder) || reportPath == "" || stock == "" {
		t.Fatal("missing restart protocol configuration")
	}
	raw, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal("missing cleanup receipt")
	}
	report := map[string]any{}
	if json.Unmarshal(raw, &report) != nil || report["remoteFolder"] != folder {
		t.Fatal("invalid cleanup receipt")
	}
	checks := []map[string]any{}
	t.Cleanup(func() {
		report["status"], report["checks"] = "passed", checks
		if t.Failed() {
			report["status"] = "failed"
		}
		data, err := json.MarshalIndent(report, "", "  ")
		if err != nil || os.WriteFile(reportPath, append(data, '\n'), 0600) != nil {
			t.Error("could not save sanitized restart receipt")
		}
	})
	m, _ := restartProbeLogin(t)
	if _, err := m.CreateDir(folder, m.FS.GetRoot()); err != nil {
		t.Fatal("isolated restart folder creation failed; details withheld")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal("missing worker executable")
	}
	for _, scenario := range []struct {
		name  string
		delay time.Duration
	}{
		{"acknowledged-prefix", 0},
		{"accepted-without-checkpoint", 15 * time.Second},
		{"lost-batched-terminal-response", time.Second},
	} {
		report["stage"] = scenario.name
		private := t.TempDir()
		if err := os.Chmod(private, 0700); err != nil {
			t.Fatal("could not restrict private protocol directory")
		}
		statePath := filepath.Join(private, "session.json")
		worker := func(phase string) {
			t.Helper()
			report["stage"] = scenario.name + "/" + phase
			cmd := exec.CommandContext(ctx, executable, "-test.run=^TestLiveUploadRestartProtocol$", "-test.timeout=7m")
			cmd.Env = append(os.Environ(), "RFORK_RESTART_PHASE="+phase, "RFORK_RESTART_CASE="+scenario.name, "RFORK_RESTART_STATE="+statePath)
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			if cmd.Run() != nil {
				raw, err := os.ReadFile(statePath + ".progress")
				var progress struct{ Stage string }
				if err == nil && json.Unmarshal(raw, &progress) == nil {
					report["workerStage"] = progress.Stage
				}
				t.Fatalf("restart worker failed (%s/%s); private output withheld", scenario.name, phase)
			}
		}
		worker("prepare")
		select {
		case <-time.After(scenario.delay):
		case <-ctx.Done():
			t.Fatal("restart probe cancelled during delay")
		}
		worker("finish")
		checks = append(checks, map[string]any{"case": scenario.name, "delaySeconds": scenario.delay.Seconds(),
			"freshAuthentication": true, "separateProcesses": true, "independentSHA256": true})
	}
	report["sessionLifetimeLimitEstablished"] = false
	report["encryptedCheckpointCodec"] = "rfork-mega-checkpoint-v1"
	report["commitIntentSavedBeforeFinalization"] = true
	report["payloadBytes"] = len(restartProbePlaintext())
	report["batchTargetBytes"] = 4 * 1024 * 1024
	report["stage"] = "complete"
}

func restartProbeLogin(t *testing.T) (*Mega, *restartProbeTransport) {
	t.Helper()
	email, password := os.Getenv("RFORK_MEGA_EMAIL"), os.Getenv("RFORK_MEGA_PASSWORD")
	if email == "" || password == "" {
		t.Fatal("missing dedicated-account credentials")
	}
	transport := &restartProbeTransport{base: http.DefaultTransport}
	m := New().SetClient(&http.Client{Timeout: 45 * time.Second, Transport: transport})
	m.SetRetries(2)
	m.SetHTTPS(true)
	m.SetLogger(nil)
	m.SetDebugger(nil)
	if m.MultiFactorLogin(email, password, "") != nil {
		t.Fatal("fresh dedicated-account login failed; details withheld")
	}
	return m, transport
}

func restartProbeRange(u *Upload, first int) int {
	count, size := 0, 0
	for first+count < u.Chunks() && len(u.chunk_macs[first+count]) == 0 {
		_, next, err := u.ChunkLocation(first + count)
		if err != nil || count > 0 && size+next > 4*1024*1024 {
			break
		}
		count++
		size += next
	}
	return count
}

func runRestartProbeWorker(ctx context.Context, t *testing.T, phase string) {
	t.Helper()
	statePath, scenario := os.Getenv("RFORK_RESTART_STATE"), os.Getenv("RFORK_RESTART_CASE")
	folder := os.Getenv("RFORK_PROTOCOL_FOLDER")
	if statePath == "" || !regexp.MustCompile(`^rfork-protocol-[a-f0-9]{32}$`).MatchString(folder) ||
		(scenario != "acknowledged-prefix" && scenario != "accepted-without-checkpoint" && scenario != "lost-batched-terminal-response") {
		t.Fatal("invalid private worker configuration")
	}
	plain := restartProbePlaintext()
	stage := "login"
	t.Cleanup(func() {
		raw, err := json.Marshal(struct{ Stage string }{stage})
		if err != nil || os.WriteFile(statePath+".progress", raw, 0600) != nil {
			t.Error("could not save private worker progress")
		}
	})
	m, transport := restartProbeLogin(t)
	stage = "account-binding"
	user, err := m.GetUser()
	if err != nil || user.U == "" {
		t.Fatal("fresh account binding failed; details withheld")
	}
	var u *Upload
	parents, err := m.FS.PathLookup(m.FS.GetRoot(), []string{folder})
	if err != nil || len(parents) != 1 || parents[0].GetType() != FOLDER {
		t.Fatal("fresh isolated parent lookup failed")
	}
	binding := UploadCheckpointBinding{Account: user.U, Parent: parents[0].GetHash(), Name: scenario + ".bin",
		Size: int64(len(plain)), SHA256: sha256.Sum256(plain)}
	switch phase {
	case "prepare":
		stage = "session-creation"
		u, err = m.NewUploadContext(ctx, parents[0], binding.Name, binding.Size, true)
		if err != nil {
			t.Fatal("restart session creation failed; details withheld")
		}
	case "finish":
		stage = "state-restore"
		info, err := os.Lstat(statePath)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 1024*1024 {
			t.Fatal("unsafe private protocol state")
		}
		raw, err := os.ReadFile(statePath)
		if err != nil {
			t.Fatal("invalid private protocol state")
		}
		var restored UploadCheckpointInfo
		u, restored, err = m.OpenUploadCheckpoint(raw, binding)
		if err != nil || restored.Phase != CheckpointUploading {
			t.Fatal("private protocol restore rejected")
		}
		parent := m.FS.HashLookup(binding.Parent)
		if parent == nil || parent.GetType() != FOLDER || parent.GetName() != folder {
			t.Fatal("fresh parent binding rejected")
		}
	default:
		t.Fatal("unknown restart worker phase")
	}
	if err := u.SetUploadRetryOptions(0, false); err != nil {
		t.Fatal(err)
	}
	stage = "data-requests"
	for first := 0; first < u.Chunks(); {
		if len(u.chunk_macs[first]) != 0 {
			offset, size, err := u.ChunkLocation(first)
			if err != nil || u.VerifyAcknowledgedChunk(first, plain[offset:offset+int64(size)]) != nil {
				t.Fatal("acknowledged range did not match source")
			}
			first++
			continue
		}
		count := restartProbeRange(u, first)
		offset, size, err := u.ChunkRangeLocation(first, count)
		if err != nil {
			t.Fatal("invalid restart range")
		}
		terminalLoss := phase == "prepare" && scenario == "lost-batched-terminal-response" && first+count == u.Chunks()
		if terminalLoss {
			if count < 2 {
				t.Fatal("terminal fault must cover multiple native chunks")
			}
			transport.mu.Lock()
			transport.target = u.uploadUrl + "/" + strconv.FormatInt(offset, 10)
			transport.mu.Unlock()
		}
		err = u.UploadRangeContext(ctx, first, count, bytes.Clone(plain[offset:offset+int64(size)]))
		if terminalLoss {
			var failure *UploadRequestError
			if !errors.As(err, &failure) || failure.Kind != "body" || len(u.completion_handle) != 0 {
				t.Fatal("terminal response loss not established")
			}
			break
		}
		if err != nil {
			t.Fatal("restart data request failed; details withheld")
		}
		if phase == "prepare" && scenario != "lost-batched-terminal-response" {
			if scenario == "accepted-without-checkpoint" {
				for i := first; i < first+count; i++ {
					u.chunk_macs[i] = nil
				}
			}
			break
		}
		first += count
	}
	if phase == "prepare" {
		stage = "private-state-write"
		raw, err := u.SealCheckpoint(binding, CheckpointUploading, "")
		if err != nil {
			t.Fatal("private state encoding failed")
		}
		writeRestartCheckpoint(t, statePath, raw, true)
		return
	}
	stage = "commit-intent"
	intent, err := u.SealCheckpoint(binding, CheckpointCommitIntent, "")
	if err != nil {
		t.Fatal("commit intent encoding failed")
	}
	writeRestartCheckpoint(t, statePath, intent, false)
	stage = "file-commit"
	node, err := u.FinishContext(ctx)
	if err != nil {
		t.Fatal("restart finalization failed; outcome may be uncertain")
	}
	committed, err := u.SealCheckpoint(binding, CheckpointCommitted, node.GetHash())
	if err != nil {
		t.Fatal("committed state encoding failed")
	}
	writeRestartCheckpoint(t, statePath, committed, false)
	stage = "independent-download"
	verifyRestartProbe(ctx, t, scenario+".bin", plain)
}

func writeRestartCheckpoint(t *testing.T, path string, raw []byte, create bool) {
	t.Helper()
	flags := os.O_WRONLY | os.O_TRUNC
	if create {
		flags = os.O_WRONLY | os.O_CREATE | os.O_EXCL
	}
	file, err := os.OpenFile(path, flags, 0600)
	if err != nil {
		t.Fatal("private checkpoint open failed")
	}
	_, writeErr := file.Write(raw)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		t.Fatal("private checkpoint write failed")
	}
}

func verifyRestartProbe(ctx context.Context, t *testing.T, name string, plain []byte) {
	t.Helper()
	stock := os.Getenv("RFORK_PROTOCOL_STOCK")
	obscure := exec.CommandContext(ctx, stock, "obscure", "-")
	obscure.Stdin = strings.NewReader(os.Getenv("RFORK_MEGA_PASSWORD") + "\n")
	obscure.Env = protocolStockEnv()
	encoded, err := obscure.Output()
	if err != nil {
		t.Fatal("independent verifier credential setup failed")
	}
	dest := filepath.Join(t.TempDir(), "download.bin")
	cmd := exec.CommandContext(ctx, stock, "copyto", "rforkproto:"+os.Getenv("RFORK_PROTOCOL_FOLDER")+"/"+name, dest,
		"--retries", "1", "--low-level-retries", "1", "--mega-use-https=true", "--timeout", "60s", "--contimeout", "20s")
	cmd.Env = append(protocolStockEnv(), "RCLONE_CONFIG=notfound", "RCLONE_CONFIG_RFORKPROTO_TYPE=mega",
		"RCLONE_CONFIG_RFORKPROTO_USER="+os.Getenv("RFORK_MEGA_EMAIL"), "RCLONE_CONFIG_RFORKPROTO_PASS="+strings.TrimSpace(string(encoded)))
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if cmd.Run() != nil {
		t.Fatal("independent restart download failed; details withheld")
	}
	data, err := os.ReadFile(dest)
	if err != nil || sha256.Sum256(data) != sha256.Sum256(plain) {
		t.Fatal("independent restart SHA-256 mismatch")
	}
}
