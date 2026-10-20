package checkpoint

import "os"

func platformFileSync(f *os.File) error { return f.Sync() }
