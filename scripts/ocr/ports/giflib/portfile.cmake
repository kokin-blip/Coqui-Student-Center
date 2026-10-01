set(EXTRA_PATCHES "")
if (VCPKG_TARGET_IS_WINDOWS AND NOT VCPKG_TARGET_IS_MINGW)
    list(APPEND EXTRA_PATCHES msvc.diff)
endif()

# SourceForge is the canonical host used by the upstream vcpkg port, but its
# disaster-recovery page can be returned in place of the archive. Fossies
# mirrors the identical upstream release tarball; keep vcpkg's pinned SHA512
# so downloaded source remains verified.
vcpkg_download_distfile(ARCHIVE
    URLS "https://fossies.org/linux/misc/giflib-${VERSION}.tar.gz"
    FILENAME "giflib-${VERSION}.tar.gz"
    SHA512 fb1d6319694745e8cdac7c57e96bd3a87dbfd978f2bfd00e826742db53398011c43f9a6e7f4375b0e77b162358ddfa14d85bce652680fb5967b72c46775c0edb
)
vcpkg_extract_source_archive(SOURCE_PATH
    ARCHIVE "${ARCHIVE}"
    PATCHES ${EXTRA_PATCHES}
)

file(COPY "${CMAKE_CURRENT_LIST_DIR}/CMakeLists.txt" DESTINATION "${SOURCE_PATH}")

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        "-DGIFLIB_EXPORTS=${CMAKE_CURRENT_LIST_DIR}/exports.def"
    OPTIONS_DEBUG
        -DGIFLIB_SKIP_HEADERS=ON
)

vcpkg_cmake_install()
vcpkg_copy_pdbs()

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/vcpkg-cmake-wrapper.cmake" DESTINATION "${CURRENT_PACKAGES_DIR}/share/gif")
file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/COPYING")
