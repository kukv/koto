# 公式 postgres イメージをベースに自前で拡張を導入する。
# - PGroonga: PGDG に無いため Groonga プロジェクトの apt リポジトリから
# - pgvector: 公式イメージに設定済みの PGDG リポジトリから
FROM postgres:18

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && . /etc/os-release \
 && wget -O /tmp/groonga-apt-source.deb \
      "https://packages.groonga.org/debian/groonga-apt-source-latest-${VERSION_CODENAME}.deb" \
 && apt-get install -y --no-install-recommends /tmp/groonga-apt-source.deb \
 && rm /tmp/groonga-apt-source.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-18-pgroonga \
      postgresql-18-pgvector \
 && apt-get purge -y --auto-remove wget \
 && rm -rf /var/lib/apt/lists/*
